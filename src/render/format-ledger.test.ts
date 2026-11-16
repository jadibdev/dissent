import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { buildPlanFields } from '../compare/derive-plan.js';
import { compareFields } from '../compare/compare-fields.js';
import { computeCoverage } from '../compare/coverage.js';
import {
  collectComparisonFindings,
  computeAdvisory,
  sortFindings,
} from '../findings.js';
import {
  adjudicate,
  corroborate,
  DissentArgumentError,
  formatLedger,
  type JSONValue,
  type Ledger,
} from '../index.js';

function stripInlineCodeSpans(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '`') {
      out += input[i];
      i += 1;
      continue;
    }
    let ticks = 0;
    while (input[i + ticks] === '`') ticks += 1;
    const fence = '`'.repeat(ticks);
    let search = i + ticks;
    let closeIdx = -1;
    while (search < input.length) {
      const hit = input.indexOf(fence, search);
      if (hit === -1) break;
      const beforeOk = hit === 0 || input[hit - 1] !== '`';
      const afterOk = input[hit + ticks] !== '`';
      if (beforeOk && afterOk) {
        closeIdx = hit;
        break;
      }
      search = hit + 1;
    }
    if (closeIdx === -1) {
      out += fence;
      i += ticks;
    } else {
      i = closeIdx + ticks;
    }
  }
  return out;
}

function makeMock(
  canonicalOrModelId: string,
  payload: unknown,
  tokens = 30,
): MockLanguageModelV4 {
  const slash = canonicalOrModelId.indexOf('/');
  const provider = slash > 0 ? canonicalOrModelId.slice(0, slash) : 'mock';
  const modelId =
    slash > 0 ? canonicalOrModelId.slice(slash + 1) : canonicalOrModelId;
  return new MockLanguageModelV4({
    provider: `${provider}.chat`,
    modelId,
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: tokens - 10,
          noCache: tokens - 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 10,
          text: 10,
          reasoning: 0,
        },
      },
      warnings: [],
    }),
  });
}

describe('Phase 5: Layer C formatting & security', () => {
  test('5.12 Rendering both formats across all comparator, witness, and adjudication shapes (§11.1)', async () => {
    const schema = z.object({
      agreed: z.boolean(),
      splitFlag: z.boolean(),
      confidence: z.number(),
      tags: z.array(z.string()),
      items: z.array(z.object({ id: z.string(), ok: z.boolean() })),
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('add'), name: z.string() }),
        z.object({ kind: z.literal('drop'), id: z.string() }),
      ]),
      reasoning: z.string(),
    });

    const ledger = await corroborate({
      witnesses: {
        gpt: makeMock('openai/gpt-4o', {
          agreed: true,
          splitFlag: false,
          confidence: 0.9,
          tags: ['api', 'types'],
          items: [{ id: 'a', ok: true }],
          action: { kind: 'add', name: 'foo' },
          reasoning: 'Line one\nLine two',
        }),
        claude: makeMock('anthropic/claude-sonnet-4', {
          agreed: true,
          splitFlag: true,
          confidence: 0.85,
          tags: ['api', 'docs'],
          items: [
            { id: 'a', ok: false },
            { id: 'b', ok: true },
          ],
          action: { kind: 'add', name: 'bar' },
          reasoning: 'Claude reasoning block',
        }),
        down: new MockLanguageModelV4({
          provider: 'google.chat',
          modelId: 'gemini-2.5-flash',
          doGenerate: async () => {
            throw new Error('rate limit');
          },
        }),
        author: makeMock('openai/gpt-4o-mini', {
          agreed: false,
          splitFlag: false,
          confidence: 0.1,
          tags: [],
          items: [],
          action: { kind: 'drop', id: 'x' },
          reasoning: 'Author',
        }),
      },
      schema,
      compare: {
        confidence: { tolerance: { absolute: 0.1 } },
        items: { key: 'id' },
      },
      provenance: {
        authorModels: ['openai/gpt-4o-mini'],
        excludeAuthor: true,
      },
      prompt: 'Review PR',
    });

    const adj = await adjudicate(ledger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      {
        source: 'api-extractor',
        outcome: 'pass',
        claim: { path: '/splitFlag', value: true },
      },
    ]);

    const md = formatLedger(ledger, {
      format: 'markdown',
      adjudication: adj,
      showOutputs: true,
    });
    const ascii = formatLedger(ledger, {
      format: 'ascii',
      adjudication: adj,
      showOutputs: true,
    });

    // Both end with exactly one newline
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
    expect(ascii.endsWith('\n')).toBe(true);
    expect(ascii.endsWith('\n\n')).toBe(false);

    // Header & coverage line (always printed)
    expect(md).toContain(ledger.fingerprint);
    expect(ascii).toContain(`${ledger.fingerprint.slice(0, 12)}…`);
    const expectedCoverage =
      'Advisory: review-required · Quorum: 2/4 answered (1 failed, 1 excluded) · Coverage: compared 7 of 10 fields (100%)';
    expect(md).toContain(expectedCoverage);
    expect(ascii).toContain(expectedCoverage);

    // Section ordering
    const mdOrder = [
      '## Dissent Ledger',
      '### Witnesses',
      '### Fields',
      '### Read side by side',
      '### Findings',
      '### Independence',
      '### Adjudication',
      '### Outputs',
    ];
    let lastPos = -1;
    for (const heading of mdOrder) {
      const idx = md.indexOf(heading);
      expect(idx, `missing heading ${heading}`).toBeGreaterThan(lastPos);
      lastPos = idx;
    }

    // ASCII 78-col rules + comparator summaries + Read side by side + failed/excluded/adjudication
    expect(ascii).toContain('='.repeat(78));
    expect(ascii).toContain('-'.repeat(78));
    expect(ascii).toContain('J=0.33');
    expect(md).toContain('J=0.33');
    expect(md).toContain('0.85–0.9 (spread 0.05)');
    expect(ascii).toContain('0.85–0.9 (spread 0.05)');
    expect(md).toContain('down | google/gemini\\-2\\.5\\-flash');
    expect(ascii).toContain(
      'down : status=failed, req=google/gemini-2.5-flash',
    );
    expect(md).toContain('excluded');
    expect(md).toContain('confirmed (artifact-evidence-passed)');
    expect(ascii).toContain('confirmed (artifact-evidence-passed)');
    expect(md).toContain('"agreed": true');
    expect(ascii).toContain('    {\n      "action": {');

    // Full-output inline snapshots with deterministic timestamp & durations
    const fixedWitnesses = Object.fromEntries(
      Object.entries(ledger.witnesses).map(([k, rec]) => [
        k,
        { ...rec, durationMs: rec.status === 'excluded' ? 0 : 12 },
      ]),
    ) as Ledger<unknown, keyof typeof ledger.witnesses>['witnesses'];
    const fixedLedger: Ledger<unknown, keyof typeof ledger.witnesses> = {
      ...ledger,
      witnesses: fixedWitnesses,
      createdAt: '2026-11-14T00:00:00.000Z',
    };
    const fixedMd = formatLedger(fixedLedger, {
      format: 'markdown',
      adjudication: adj,
      showOutputs: true,
    });
    const fixedAscii = formatLedger(fixedLedger, {
      format: 'ascii',
      adjudication: adj,
      showOutputs: true,
    });
    expect(fixedMd).toMatchInlineSnapshot(`
      "## Dissent Ledger

      - **Protocol:** dissent-ledger/1
      - **Fingerprint:** d7079281595809fc5aed2f950322936ea01a4c52ab33f3a5a7e5cd1d9b866a9c
      - **Created:** 2026-11-14T00:00:00.000Z

      Advisory: review-required · Quorum: 2/4 answered (1 failed, 1 excluded) · Coverage: compared 7 of 10 fields (100%)

      ### Witnesses

      | Label | Requested | Served | Status | Detail | Duration | Tokens |
      |---|---|---|---|---|---:|---:|
      | author | openai/gpt\\-4o\\-mini | — | excluded | before-dispatch (requested=openai/gpt\\-4o\\-mini) | 0ms | — |
      | claude | anthropic/claude\\-sonnet\\-4 | anthropic/claude\\-sonnet\\-4 | answered | — | 12ms | 30 |
      | down | google/gemini\\-2\\.5\\-flash | — | failed | unknown: rate limit | 12ms | — |
      | gpt | openai/gpt\\-4o | openai/gpt\\-4o | answered | — | 12ms | 30 |

      ### Fields

      | Path | Comparator | Status | Summary |
      |---|---|---|---|
      | /action | discriminated-union | agree | by kind: \`"add"\` (2/2) |
      | /agreed | exact | agree | \`true\` (2/2) |
      | /confidence | tolerance | agree | 0.85–0.9 (spread 0.05) · 0.85–0.9 (2/2) |
      | /items | keyed-set | split | key=id · ∩ 1 · ∪ 2 · J=0.50 |
      | /reasoning | none | not-compared | policy/free\\-text |
      | /splitFlag | exact | split | \`false\` (1/2), \`true\` (1/2) |
      | /tags | set | split | ∩ 1 · ∪ 3 · J=0.33: \`"docs"\` (1/2), \`"types"\` (1/2) |

      #### /action

      - branch=\`"add"\` (claude, gpt)
        - /name: policy/free\\-text

      #### /items

      - key=\`"a"\` (claude, gpt)
        - /ok: \`false\` (1/2), \`true\` (1/2)
      - key=\`"b"\` (claude)
        - /ok: \`true\` (1/1)

      ### Read side by side

      - **/reasoning — claude:**

      \`\`\`
      Claude reasoning block
      \`\`\`

      - **/reasoning — gpt:**

      \`\`\`
      Line one
      Line two
      \`\`\`

      ### Findings

      | Severity | Code | Target | Witnesses |
      |---|---|---|---|
      | critical | field-split | /items [key=\`"a"\`] /ok | claude, gpt |
      | critical | field-split | /splitFlag | claude, gpt |
      | warn | field-split | /items | claude, gpt |
      | warn | field-split | /tags | claude, gpt |
      | warn | witness-failed | — | down |
      | info | witness-excluded | — | author |

      ### Independence

      - **Unique requested providers:** 3
      - **Self-grading witnesses:** author (requested=openai/gpt\\-4o\\-mini)
      - **Excluded witnesses:** author (before-dispatch, requested=openai/gpt\\-4o\\-mini)

      ### Adjudication

      - **Verdict:** confirmed (artifact-evidence-passed)
      - **Artifact evidence:** pass=1, fail=0, error=0, unknown=0
      - **Unbound:** 0
      - **Conflicts:** 0

      | Path | Value | Source | Outcome | Agreeing | Dissenting | Silent |
      |---|---|---|---|---|---|---|
      | /splitFlag | \`true\` | api\\-extractor | pass | claude | gpt | author, down |

      ### Outputs

      - **claude:**

      \`\`\`
      {
        "action": {
          "kind": "add",
          "name": "bar"
        },
        "agreed": true,
        "confidence": 0.85,
        "items": [
          {
            "id": "a",
            "ok": false
          },
          {
            "id": "b",
            "ok": true
          }
        ],
        "reasoning": "Claude reasoning block",
        "splitFlag": true,
        "tags": [
          "api",
          "docs"
        ]
      }
      \`\`\`

      - **gpt:**

      \`\`\`
      {
        "action": {
          "kind": "add",
          "name": "foo"
        },
        "agreed": true,
        "confidence": 0.9,
        "items": [
          {
            "id": "a",
            "ok": true
          }
        ],
        "reasoning": "Line one\\nLine two",
        "splitFlag": false,
        "tags": [
          "api",
          "types"
        ]
      }
      \`\`\`
      "
    `);
    expect(fixedAscii).toMatchInlineSnapshot(`
      "==============================================================================
      Dissent Ledger
      ==============================================================================
      Protocol    : dissent-ledger/1
      Fingerprint : d70792815958…
      Created     : 2026-11-14T00:00:00.000Z

      Advisory: review-required · Quorum: 2/4 answered (1 failed, 1 excluded) · Coverage: compared 7 of 10 fields (100%)

      Witnesses
      ------------------------------------------------------------------------------
      author : status=excluded, req=openai/gpt-4o-mini, served=—, detail=before-dispatch (requested=openai/gpt-4o-mini), duration=0ms, tokens=—
      claude : status=answered, req=anthropic/claude-sonnet-4, served=anthropic/claude-sonnet-4, detail=—, duration=12ms, tokens=30
      down : status=failed, req=google/gemini-2.5-flash, served=—, detail=unknown: rate limit, duration=12ms, tokens=—
      gpt : status=answered, req=openai/gpt-4o, served=openai/gpt-4o, detail=—, duration=12ms, tokens=30

      Fields
      ------------------------------------------------------------------------------
      /action : discriminated-union [agree] -- by kind: "add" (2/2)
        branch="add" (claude, gpt)
          /name : policy/free-text
      /agreed : exact [agree] -- true (2/2)
      /confidence : tolerance [agree] -- 0.85–0.9 (spread 0.05) · 0.85–0.9 (2/2)
      /items : keyed-set [split] -- key=id · ∩ 1 · ∪ 2 · J=0.50
        key="a" (claude, gpt)
          /ok : false (1/2), true (1/2)
        key="b" (claude)
          /ok : true (1/1)
      /reasoning : none [not-compared] -- policy/free-text
      /splitFlag : exact [split] -- false (1/2), true (1/2)
      /tags : set [split] -- ∩ 1 · ∪ 3 · J=0.33: "docs" (1/2), "types" (1/2)

      Read side by side
      ------------------------------------------------------------------------------
      /reasoning (claude) :
          Claude reasoning block
      /reasoning (gpt) :
          Line one
          Line two

      Findings
      ------------------------------------------------------------------------------
      critical : field-split, target=/items [key="a"] /ok, witnesses=claude, gpt
      critical : field-split, target=/splitFlag, witnesses=claude, gpt
      warn : field-split, target=/items, witnesses=claude, gpt
      warn : field-split, target=/tags, witnesses=claude, gpt
      warn : witness-failed, target=—, witnesses=down
      info : witness-excluded, target=—, witnesses=author

      Independence
      ------------------------------------------------------------------------------
      Unique requested providers : 3
      Self-grading witnesses : author (requested=openai/gpt-4o-mini)
      Excluded witnesses : author (before-dispatch, requested=openai/gpt-4o-mini)

      Adjudication
      ------------------------------------------------------------------------------
      Verdict           : confirmed (artifact-evidence-passed)
      Artifact evidence : pass=1, fail=0, error=0, unknown=0
      Unbound           : 0
      Conflicts         : 0
        /splitFlag : value=true, source=api-extractor, outcome=pass, agree=[claude], dissent=[gpt], silent=[author, down]

      Outputs
      ------------------------------------------------------------------------------
      claude :
          {
            "action": {
              "kind": "add",
              "name": "bar"
            },
            "agreed": true,
            "confidence": 0.85,
            "items": [
              {
                "id": "a",
                "ok": false
              },
              {
                "id": "b",
                "ok": true
              }
            ],
            "reasoning": "Claude reasoning block",
            "splitFlag": true,
            "tags": [
              "api",
              "docs"
            ]
          }
      gpt :
          {
            "action": {
              "kind": "add",
              "name": "foo"
            },
            "agreed": true,
            "confidence": 0.9,
            "items": [
              {
                "id": "a",
                "ok": true
              }
            ],
            "reasoning": "Line one\\nLine two",
            "splitFlag": false,
            "tags": [
              "api",
              "types"
            ]
          }
      "
    `);

    // Non-array raw value for set/keyed-set (Handoff P3-6)
    const setPlan = buildPlanFields(
      {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags'],
        additionalProperties: false,
      },
      undefined,
    );
    const rawOutputs: Array<{ witness: 'a' | 'b' | 'c'; output: JSONValue }> = [
      { witness: 'a', output: { tags: ['x'] } },
      { witness: 'b', output: { tags: ['x'] } },
      { witness: 'c', output: { tags: 'oops' } },
    ];
    const setFields = compareFields(setPlan, rawOutputs);
    const setCov = computeCoverage(setPlan, setFields);
    const setFindings = sortFindings(
      collectComparisonFindings({
        answered: 3,
        planFields: setPlan,
        fieldResults: setFields,
        coverage: setCov,
      }),
    );
    const setLedger: Ledger<unknown, 'a' | 'b' | 'c'> = {
      protocol: 'dissent-ledger/1',
      fingerprint: 'a'.repeat(64),
      question: {
        fingerprint: 'b'.repeat(64),
        inputKind: 'prompt',
        inputHash: 'c'.repeat(64),
        instructionsHash: null,
        schemaHash: 'd'.repeat(64),
        inputBytes: 10,
        lineEndings: 'normalized-for-hash',
      },
      plan: { fingerprint: 'e'.repeat(64), fields: setPlan },
      witnesses: {
        a: {
          requested: {
            provider: 'p',
            modelId: 'm',
            canonicalId: 'p/m',
            providerKey: 'p',
          },
          served: null,
          status: 'answered',
          output: { tags: ['x'] },
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          warnings: [],
          durationMs: 1,
        },
        b: {
          requested: {
            provider: 'p',
            modelId: 'm',
            canonicalId: 'p/m',
            providerKey: 'p',
          },
          served: null,
          status: 'answered',
          output: { tags: ['x'] },
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          warnings: [],
          durationMs: 1,
        },
        c: {
          requested: {
            provider: 'p',
            modelId: 'm',
            canonicalId: 'p/m',
            providerKey: 'p',
          },
          served: null,
          status: 'answered',
          output: { tags: 'oops' },
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          warnings: [],
          durationMs: 1,
        },
      },
      quorum: { listed: 3, asked: 3, answered: 3, failed: 0, excluded: 0 },
      independence: {
        uniqueRequestedProviders: 1,
        duplicateServedModels: [],
        sameProviderGroups: [],
        selfGradingWitnesses: [],
        excludedWitnesses: [],
      },
      fields: setFields,
      coverage: setCov,
      findings: setFindings,
      advisory: computeAdvisory(setFindings),
      usage: {
        perWitness: { a: null, b: null, c: null },
        total: {
          inputTokens: 3,
          outputTokens: 3,
          totalTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
      createdAt: '2026-11-14T00:00:00.000Z',
    };
    const setMd = formatLedger(setLedger);
    expect(setMd).toContain('non-array: c=`"oops"`');
  });

  test('5.13 Hostile strings across every untrusted slot (I15, D27)', async () => {
    const hostile =
      '| ` ``` <script> [x](javascript:1) ![i](http://x) @user #1 \x1b[2J \x1b]52;c;YQ==\x07 \u202e \u200b \u009b';
    const hostileId =
      'id|@admin`<script>[l](x)![i](y)\x1b[31m\u202e\u200b\u009b';

    const ledger = await corroborate({
      witnesses: {
        w1: new MockLanguageModelV4({
          provider: 'p1',
          modelId: hostileId,
          doGenerate: async () => ({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  flag: true,
                  notes: hostile,
                  exactStr: hostile,
                }),
              },
            ],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
            response: { modelId: hostileId },
          }),
        }),
        w2: makeMock('p2/m2', {
          flag: false,
          notes: 'clean',
          exactStr: '```',
        }),
        errw: new MockLanguageModelV4({
          provider: 'p3',
          modelId: 'p3/err',
          doGenerate: async () => {
            throw new Error(hostile);
          },
        }),
      },
      schema: z.object({
        flag: z.boolean(),
        notes: z.string(),
        exactStr: z.string(),
      }),
      compare: { exactStr: 'exact' },
      prompt: 'Check',
    });

    const adj = await adjudicate(ledger, [
      {
        source: `src|@reviewer<script>[a](b)![c](d)\x1b[2J\u202e`,
        outcome: 'pass',
        claim: { path: '/exactStr', value: '```' },
      },
      {
        source: `src|<script>[a](b)![c](d)&amp;`,
        outcome: 'pass',
        claim: { path: '/flag', value: true },
      },
    ]);

    const md = formatLedger(ledger, {
      format: 'markdown',
      adjudication: adj,
      showOutputs: true,
    });
    const ascii = formatLedger(ledger, {
      format: 'ascii',
      adjudication: adj,
      showOutputs: true,
    });

    // No raw control characters (\x1b, C1 \u0080-\u009f, BiDi \u202e, zero-width \u200b) in EITHER format
    // oxlint-disable-next-line no-control-regex
    const forbiddenControls = /[\x1b\u0080-\u009f\u202a-\u202e\u200b-\u200f]/;
    expect(md).not.toMatch(forbiddenControls);
    expect(ascii).not.toMatch(forbiddenControls);

    // Q2: `@` inline values wrap in code spans (never `&#64;`, which GitHub still links);
    // non-`@` inline values backslash-escape Markdown punctuation (`\<script\>`).
    expect(md).not.toContain('&#64;');
    expect(md).toContain('``p1/id\\|@admin`<script>[l](x)![i](y)``');
    expect(md).toContain('`src\\|@reviewer<script>[a](b)![c](d)`');
    expect(md).toContain(
      'src\\|\\<script\\>\\[a\\]\\(b\\)\\!\\[c\\]\\(d\\)&amp;amp;',
    );
    // Check Markdown table structure outside fenced blocks: exact separator column count on every data row
    const mdNoFences = md.replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, '');
    const mdLines = mdNoFences.split('\n');
    let expectedTableCols: number | null = null;
    let sawTables = 0;
    for (let i = 0; i < mdLines.length; i++) {
      const line = mdLines[i]!;
      if (line.startsWith('|')) {
        const nextLine = mdLines[i + 1] ?? '';
        if (expectedTableCols === null && /^\|(?:-+:?\|)+$/.test(nextLine)) {
          expectedTableCols = nextLine.split('|').length - 2;
          sawTables++;
        }
        if (/^\|(?:-+:?\|)+$/.test(line)) continue;
        const cells = line.split(/(?<!\\)\|/);
        expect(cells[0]).toBe('');
        expect(cells[cells.length - 1]).toBe('');
        expect(cells.length - 2).toBe(expectedTableCols);
      } else {
        expectedTableCols = null;
      }
    }
    expect(sawTables).toBeGreaterThanOrEqual(4);

    // Header & inline token newline/tab collapse (§11.3 step 2): untrusted metadata cannot inject headings
    const injectedLedger: Ledger<unknown, string> = {
      ...ledger,
      protocol: 'dissent-ledger/1\n## INJECTED PROTOCOL\tTAB' as Ledger<
        unknown,
        string
      >['protocol'],
      fingerprint: 'abc\r\n## INJECTED FP\tTAB',
      createdAt: '2026-11-14T00:00:00.000Z\n## INJECTED CREATED',
      advisory: 'warnings\n## INJECTED ADVISORY\tTAB' as Ledger<
        unknown,
        string
      >['advisory'],
    };
    const injectedAdj = {
      ...adj,
      verdict: 'confirmed\n## INJECTED VERDICT' as typeof adj.verdict,
      verdictReason:
        'artifact-evidence-passed\n## INJECTED REASON\tTAB' as typeof adj.verdictReason,
    };
    for (const fmt of ['markdown', 'ascii'] as const) {
      const out = formatLedger(injectedLedger, {
        format: fmt,
        adjudication: injectedAdj,
      });
      expect(out).not.toMatch(/^## INJECTED/m);
      expect(out).not.toContain('\t');
      expect(out).not.toContain('\r');
    }

    // Verify fenced blocks use strictly more backticks than any internal run
    const fenceMatches = Array.from(md.matchAll(/^(`{3,})$/gm));
    expect(fenceMatches.length).toBeGreaterThanOrEqual(2);
    // The hostile string has ``` -> fence around it MUST be ```` (at least 4 backticks)
    expect(md).toContain('````\n');

    // No unescaped HTML / links / @mentions in inline prose/table text outside backtick spans and fences
    const mdOutsideCode = stripInlineCodeSpans(mdNoFences);
    expect(mdOutsideCode).not.toContain('@');
    expect(mdOutsideCode).not.toMatch(/(?<!\\)</);
    expect(mdOutsideCode).not.toMatch(/(?<!\\)\[[^\]]*\]\(/);
    expect(mdOutsideCode).not.toMatch(/(?<!\\)!\[[^\]]*\]\(/);
  });

  test('5.14 Truncation: values over maxInlineChars and blocks over maxBlockChars', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeMock('p1/m1', {
          code: 'a'.repeat(50),
          notes: 'b'.repeat(60),
        }),
        w2: makeMock('p2/m2', {
          code: 'c'.repeat(50),
          notes: 'd'.repeat(20),
        }),
      },
      schema: z.object({ code: z.string(), notes: z.string() }),
      compare: { code: 'exact' },
      prompt: 'Check',
    });

    const md = formatLedger(ledger, {
      format: 'markdown',
      maxInlineChars: 20,
      maxBlockChars: 25,
    });
    expect(md).not.toContain('a'.repeat(50));
    expect(md).toContain('…');
    expect(md).toContain('… (truncated, 35 more characters)');

    const ascii = formatLedger(ledger, {
      format: 'ascii',
      maxInlineChars: 20,
      maxBlockChars: 25,
    });
    expect(ascii).not.toContain('a'.repeat(50));
    expect(ascii).toContain('… (truncated, 35 more characters)');

    // Invalid option errors
    expect(() => formatLedger(ledger, { maxInlineChars: 0 })).toThrow(
      DissentArgumentError,
    );
    expect(() =>
      formatLedger(ledger, { format: 'html' as 'markdown' }),
    ).toThrow(DissentArgumentError);
  });

  test('5.15 Determinism: rendering twice and after JSON round-trip yields identical strings (I3)', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeMock('p1/m1', { ok: true, notes: 'hello' }),
        w2: makeMock('p2/m2', { ok: false, notes: 'world' }),
      },
      schema: z.object({ ok: z.boolean(), notes: z.string() }),
      prompt: 'Check',
    });
    const adj = await adjudicate(ledger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      { source: 'lint', outcome: 'pass', claim: { path: '/ok', value: true } },
    ]);

    const roundTripLedger = JSON.parse(JSON.stringify(ledger)) as Ledger<
      unknown,
      string
    >;
    const roundTripAdj = JSON.parse(JSON.stringify(adj)) as typeof adj;

    expect(
      formatLedger(ledger, { format: 'markdown', adjudication: adj }),
    ).toBe(
      formatLedger(roundTripLedger, {
        format: 'markdown',
        adjudication: roundTripAdj,
      }),
    );
    expect(formatLedger(ledger, { format: 'ascii', adjudication: adj })).toBe(
      formatLedger(roundTripLedger, {
        format: 'ascii',
        adjudication: roundTripAdj,
      }),
    );
  });

  test('5.16 Layer purity scan of src/adjudicate.ts, src/receipt.ts, src/sanitize.ts, src/render/** (I16)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.resolve(here, '..');
    const filesToScan = [
      path.join(srcDir, 'adjudicate.ts'),
      path.join(srcDir, 'receipt.ts'),
      path.join(srcDir, 'sanitize.ts'),
      path.join(srcDir, 'render', 'escape.ts'),
      path.join(srcDir, 'render', 'format-markdown.ts'),
      path.join(srcDir, 'render', 'format-ascii.ts'),
      path.join(srcDir, 'render', 'format-ledger.ts'),
    ];

    const forbiddenModule =
      '(?:ai|ai/|@ai-sdk/|node:|[^\'"]*(?:witness|corroborate))';
    const forbiddenFromImport = new RegExp(
      `^\\s*(?:import|export)\\b(?![\\t ]+type\\b)[^;]*?\\bfrom\\s*['"]${forbiddenModule}`,
      'm',
    );
    const forbiddenSideEffectImport = new RegExp(
      `^\\s*import\\s*['"]${forbiddenModule}`,
      'm',
    );
    const forbiddenDynamicEval =
      /\b(?:import|require|eval)\s*\(|\bnew\s+Function\s*\(/;
    const forbiddenGlobals = /\b(?:process|Buffer|Date\.now|Math\.random)\b/;

    for (const file of filesToScan) {
      const raw = fs.readFileSync(file, 'utf8');
      const stripped = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(stripped, `${file} has forbidden runtime import`).not.toMatch(
        forbiddenFromImport,
      );
      expect(stripped, `${file} has forbidden side-effect import`).not.toMatch(
        forbiddenSideEffectImport,
      );
      expect(stripped, `${file} has dynamic import/require/eval`).not.toMatch(
        forbiddenDynamicEval,
      );
      expect(stripped, `${file} has forbidden global/clock/random`).not.toMatch(
        forbiddenGlobals,
      );
    }
  });
});
