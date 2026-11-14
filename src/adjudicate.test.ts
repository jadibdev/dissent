import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  adjudicate,
  corroborate,
  DissentArgumentError,
  validateOfflineReceipt,
  type Advisory,
  type Evidence,
  type ExecutionEnvironmentReceipt,
  type Ledger,
  type WitnessRecord,
} from './index.js';

function makeWitnessModel(
  modelId: string,
  payload: unknown,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: `${modelId.split('/')[0] ?? 'mock'}.chat`,
    modelId,
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 20,
          text: 20,
          reasoning: 0,
        },
      },
      warnings: [],
    }),
  });
}

function makeFailedModel(modelId: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'broken.chat',
    modelId,
    doGenerate: async () => {
      throw new Error('upstream failure');
    },
  });
}

function makeValidReceipt(
  overrides: Partial<ExecutionEnvironmentReceipt> = {},
): ExecutionEnvironmentReceipt {
  return {
    provider: 'epistemic-sandbox',
    profile: 'offline-verification-v1',
    runtimeImageDigest: 'sha256:image-1',
    networkPolicyEnforced: true,
    networkPolicySha256: 'sha256:policy-1',
    receiptId: 'rcpt-100',
    region: 'us-east-1',
    ...overrides,
  };
}

function forceAdvisory<W extends string>(
  ledger: Ledger<unknown, W>,
  advisory: Advisory,
): Ledger<unknown, W> {
  return { ...ledger, advisory };
}

describe('Phase 5: Layer C adjudication & receipts', () => {
  test('5.1 Verdict table cell by cell (I12, §10.4)', async () => {
    const schema = z.object({ changesPublicApi: z.boolean() });
    const warnLedger = await corroborate({
      witnesses: {
        gpt: makeWitnessModel('openai/gpt-4o', { changesPublicApi: true }),
        claude: makeWitnessModel('anthropic/claude-sonnet-4', {
          changesPublicApi: false,
        }),
      },
      schema,
      compare: { changesPublicApi: { onSplit: 'warn' } },
      prompt: 'Check API',
    });
    expect(warnLedger.advisory).toBe('warnings');

    const reviewLedger = await corroborate({
      witnesses: {
        gpt: makeWitnessModel('openai/gpt-4o', { changesPublicApi: true }),
        claude: makeWitnessModel('anthropic/claude-sonnet-4', {
          changesPublicApi: false,
        }),
      },
      schema,
      compare: { changesPublicApi: { onSplit: 'critical' } },
      prompt: 'Check API',
    });
    expect(reviewLedger.advisory).toBe('review-required');

    // Empty artifact evidence -> uncertain / no-artifact-evidence
    const emptyAdj = await adjudicate(reviewLedger, []);
    expect(emptyAdj.verdict).toBe('uncertain');
    expect(emptyAdj.verdictReason).toBe('no-artifact-evidence');
    expect(emptyAdj.artifactEvidence).toEqual({
      pass: 0,
      fail: 0,
      error: 0,
      unknown: 0,
    });

    // Any fail -> rejected / artifact-evidence-failed
    const failAdj = await adjudicate(reviewLedger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      { source: 'tsc', outcome: 'fail', claim: { scope: 'artifact' } },
    ]);
    expect(failAdj.verdict).toBe('rejected');
    expect(failAdj.verdictReason).toBe('artifact-evidence-failed');
    expect(failAdj.artifactEvidence).toEqual({
      pass: 1,
      fail: 1,
      error: 0,
      unknown: 0,
    });

    // Error or unknown without fail -> uncertain / artifact-evidence-inconclusive
    const errorAdj = await adjudicate(reviewLedger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      { source: 'lint', outcome: 'error', claim: { scope: 'artifact' } },
    ]);
    expect(errorAdj.verdict).toBe('uncertain');
    expect(errorAdj.verdictReason).toBe('artifact-evidence-inconclusive');

    const unknownAdj = await adjudicate(reviewLedger, [
      { source: 'audit', outcome: 'unknown', claim: { scope: 'artifact' } },
    ]);
    expect(unknownAdj.verdict).toBe('uncertain');
    expect(unknownAdj.verdictReason).toBe('artifact-evidence-inconclusive');

    // All pass -> confirmed / artifact-evidence-passed (and receiptChecks empty when unset/false)
    const passAdj = await adjudicate(reviewLedger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
    ]);
    expect(passAdj.verdict).toBe('confirmed');
    expect(passAdj.verdictReason).toBe('artifact-evidence-passed');
    expect(passAdj.receiptChecks).toEqual([]);

    const falseOptAdj = await adjudicate(
      reviewLedger,
      [
        {
          source: 'vitest',
          outcome: 'pass',
          claim: { scope: 'artifact' },
          receipt: makeValidReceipt({ networkPolicyEnforced: false }),
        },
      ],
      { requireOfflineReceipt: false },
    );
    expect(falseOptAdj.verdict).toBe('confirmed');
    expect(falseOptAdj.receiptChecks).toEqual([]);

    // All pass + escalateOnReview + review-required -> uncertain / escalated-on-review
    const escalatedAdj = await adjudicate(
      reviewLedger,
      [{ source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } }],
      { escalateOnReview: true },
    );
    expect(escalatedAdj.verdict).toBe('uncertain');
    expect(escalatedAdj.verdictReason).toBe('escalated-on-review');

    // All pass + escalateOnReview + warnings -> confirmed / artifact-evidence-passed
    const warnEscAdj = await adjudicate(
      warnLedger,
      [{ source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } }],
      { escalateOnReview: true },
    );
    expect(warnEscAdj.verdict).toBe('confirmed');
    expect(warnEscAdj.verdictReason).toBe('artifact-evidence-passed');
  });

  test('5.2 A model never causes rejected across a matrix of ledger states (I12)', async () => {
    const schema = z.object({ ok: z.boolean(), notes: z.string() });
    const okSchema = z.object({ ok: z.boolean() });

    const matrix: Array<Ledger<unknown, string>> = [
      // 1. All failed
      await corroborate({
        witnesses: {
          a: makeFailedModel('bad-1'),
          b: makeFailedModel('bad-2'),
        },
        schema: okSchema,
        prompt: 'Check',
      }),
      // 2. Quorum split on critical boolean
      await corroborate({
        witnesses: {
          a: makeWitnessModel('openai/gpt-4o', { ok: true, notes: 'yes' }),
          b: makeWitnessModel('anthropic/claude-sonnet-4', {
            ok: false,
            notes: 'no',
          }),
        },
        schema,
        compare: { ok: { onSplit: 'critical' } },
        prompt: 'Check',
      }),
      // 3. Self-grading + same-provider + warning split
      await corroborate({
        witnesses: {
          a: makeWitnessModel('openai/gpt-4o', { ok: true, notes: 'x' }),
          b: makeWitnessModel('openai/gpt-4o-mini', { ok: false, notes: 'y' }),
        },
        schema,
        compare: { ok: { onSplit: 'warn' } },
        provenance: { authorModels: ['openai/gpt-4o'] },
        prompt: 'Check',
      }),
      // 4. Unanimous agreement forced to review-required
      forceAdvisory(
        await corroborate({
          witnesses: {
            a: makeWitnessModel('openai/gpt-4o', { ok: true }),
            b: makeWitnessModel('anthropic/claude-sonnet-4', { ok: true }),
          },
          schema: okSchema,
          prompt: 'Check',
        }),
        'review-required',
      ),
    ];

    for (const ledger of matrix) {
      for (const escalateOnReview of [false, true]) {
        const noEv = await adjudicate(ledger, [], { escalateOnReview });
        const passEv = await adjudicate(
          ledger,
          [{ source: 'build', outcome: 'pass', claim: { scope: 'artifact' } }],
          { escalateOnReview },
        );
        const fieldFailEv = await adjudicate(
          ledger,
          [
            {
              source: 'tool',
              outcome: 'fail',
              claim: { path: '/ok', value: false },
            },
          ],
          { escalateOnReview },
        );
        expect(noEv.verdict).not.toBe('rejected');
        expect(passEv.verdict).not.toBe('rejected');
        expect(fieldFailEv.verdict).not.toBe('rejected');
      }
    }
  });

  test('5.3 Field-bound evidence never moves the verdict (I12, D6)', async () => {
    const ledger = await corroborate({
      witnesses: {
        gpt: makeWitnessModel('openai/gpt-4o', { changesPublicApi: true }),
        claude: makeWitnessModel('anthropic/claude-sonnet-4', {
          changesPublicApi: true,
        }),
      },
      schema: z.object({ changesPublicApi: z.boolean() }),
      prompt: 'Check API',
    });

    const adj = await adjudicate(ledger, [
      {
        source: 'api-extractor',
        outcome: 'fail',
        claim: { path: '/changesPublicApi', value: true },
      },
    ]);

    expect(adj.verdict).toBe('uncertain');
    expect(adj.verdictReason).toBe('no-artifact-evidence');
    expect(adj.settlements).toHaveLength(1);
    expect(adj.settlements[0]?.outcome).toBe('fail');
  });

  test('5.4 Split settled by a tool; failed fourth witness is silent (§10.3)', async () => {
    const ledger3 = await corroborate({
      witnesses: {
        gpt: makeWitnessModel('openai/gpt-4o', { changesPublicApi: false }),
        claude: makeWitnessModel('anthropic/claude-sonnet-4', {
          changesPublicApi: false,
        }),
        gemini: makeWitnessModel('google/gemini-2.5-flash', {
          changesPublicApi: true,
        }),
      },
      schema: z.object({ changesPublicApi: z.boolean() }),
      prompt: 'Check API',
    });

    const ev: Evidence[] = [
      {
        source: 'api-extractor',
        outcome: 'pass',
        claim: { path: 'changesPublicApi', value: true },
      },
    ];
    const adj3 = await adjudicate(ledger3, ev);
    expect(adj3.settlements).toHaveLength(1);
    expect(adj3.settlements[0]).toEqual({
      path: '/changesPublicApi',
      value: true,
      source: 'api-extractor',
      outcome: 'pass',
      comparator: 'exact',
      witnessesAgreeing: ['gemini'],
      witnessesDissenting: ['claude', 'gpt'],
      witnessesSilent: [],
    });

    const ledger4 = await corroborate({
      witnesses: {
        gpt: makeWitnessModel('openai/gpt-4o', { changesPublicApi: false }),
        claude: makeWitnessModel('anthropic/claude-sonnet-4', {
          changesPublicApi: false,
        }),
        gemini: makeWitnessModel('google/gemini-2.5-flash', {
          changesPublicApi: true,
        }),
        broken: makeFailedModel('broken-model'),
      },
      schema: z.object({ changesPublicApi: z.boolean() }),
      prompt: 'Check API',
    });
    const adj4 = await adjudicate(ledger4, ev);
    expect(adj4.settlements[0]).toEqual({
      path: '/changesPublicApi',
      value: true,
      source: 'api-extractor',
      outcome: 'pass',
      comparator: 'exact',
      witnessesAgreeing: ['gemini'],
      witnessesDissenting: ['claude', 'gpt'],
      witnessesSilent: ['broken'],
    });
  });

  test('5.5 Settlement comparators: tolerance, set, keyed-set, discriminated-union, none -> not-comparable (D24)', async () => {
    const schema = z.object({
      score: z.number(),
      tags: z.array(z.string()),
      items: z.array(z.object({ id: z.string(), ok: z.boolean() })),
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('add'), name: z.string() }),
        z.object({ kind: z.literal('remove'), id: z.number() }),
      ]),
      notes: z.string(),
    });

    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', {
          score: 0.82,
          tags: ['b', 'a', 'a'],
          items: [
            { id: 'x', ok: true },
            { id: 'y', ok: false },
          ],
          action: { kind: 'remove', id: 7 },
          notes: 'same',
        }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', {
          score: 0.95,
          tags: ['a', 'c'],
          items: [{ id: 'y', ok: false }],
          action: { kind: 'add', name: 'fn' },
          notes: 'different',
        }),
      },
      schema,
      compare: {
        score: { tolerance: { absolute: 0.05 } },
        items: { key: 'id' },
      },
      prompt: 'Compare all',
    });

    const adj = await adjudicate(ledger, [
      {
        source: 'scorer',
        outcome: 'pass',
        claim: { path: '/score', value: 0.8 },
      },
      {
        source: 'tagger',
        outcome: 'pass',
        claim: { path: '/tags', value: ['a', 'b'] },
      },
      {
        source: 'item-check',
        outcome: 'pass',
        claim: {
          path: '/items',
          value: [
            { id: 'y', ok: false },
            { id: 'x', ok: true },
          ],
        },
      },
      {
        source: 'ast-diff',
        outcome: 'pass',
        claim: { path: '/action', value: { kind: 'remove', id: 7 } },
      },
      {
        source: 'linter',
        outcome: 'pass',
        claim: { path: '/notes', value: 'same' },
      },
    ]);

    const byPath = new Map(adj.settlements.map(s => [s.path, s]));

    expect(byPath.get('/action')?.comparator).toBe('discriminated-union');
    expect(byPath.get('/action')?.witnessesAgreeing).toEqual(['w1']);
    expect(byPath.get('/action')?.witnessesDissenting).toEqual(['w2']);

    expect(byPath.get('/items')?.comparator).toBe('keyed-set');
    expect(byPath.get('/items')?.witnessesAgreeing).toEqual(['w1']);
    expect(byPath.get('/items')?.witnessesDissenting).toEqual(['w2']);

    expect(byPath.get('/notes')?.comparator).toBe('not-comparable');
    expect(byPath.get('/notes')?.witnessesAgreeing).toEqual([]);
    expect(byPath.get('/notes')?.witnessesDissenting).toEqual([]);
    expect(byPath.get('/notes')?.witnessesSilent).toEqual(['w1', 'w2']);

    expect(byPath.get('/score')?.comparator).toBe('tolerance');
    expect(byPath.get('/score')?.witnessesAgreeing).toEqual(['w1']);
    expect(byPath.get('/score')?.witnessesDissenting).toEqual(['w2']);

    expect(byPath.get('/tags')?.comparator).toBe('set');
    expect(byPath.get('/tags')?.witnessesAgreeing).toEqual(['w1']);
    expect(byPath.get('/tags')?.witnessesDissenting).toEqual(['w2']);

    // I7: JSON round-trip identity & I8: no undefined keys
    expect(JSON.parse(JSON.stringify(adj))).toEqual(adj);
  });

  test('5.6 Unbound evidence: no-claim, unknown-path, keyed item subpath; verdict/settlements unchanged (I11, D23)', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', {
          ok: true,
          items: [{ id: 'a', count: 1 }],
        }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', {
          ok: true,
          items: [{ id: 'a', count: 2 }],
        }),
      },
      schema: z.object({
        ok: z.boolean(),
        items: z.array(z.object({ id: z.string(), count: z.number() })),
      }),
      compare: { items: { key: 'id' } },
      prompt: 'Check',
    });

    const baseEvidence: Evidence[] = [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      {
        source: 'checker',
        outcome: 'pass',
        claim: { path: '/ok', value: true },
      },
    ];
    const extraUnbound: Evidence[] = [
      { source: 'z-noclaim', outcome: 'fail' },
      {
        source: 'm-unknown',
        outcome: 'fail',
        claim: { path: '/doesNotExist', value: 42 },
      },
      {
        source: 'a-subpath',
        outcome: 'pass',
        claim: { path: '/items/0/count', value: 1 },
      },
    ];

    const adjBase = await adjudicate(ledger, baseEvidence);
    const adjWithUnbound = await adjudicate(ledger, [
      ...baseEvidence,
      ...extraUnbound,
    ]);

    expect(adjWithUnbound.verdict).toBe(adjBase.verdict);
    expect(adjWithUnbound.verdictReason).toBe(adjBase.verdictReason);
    expect(adjWithUnbound.settlements).toEqual(adjBase.settlements);
    expect(adjWithUnbound.conflicts).toEqual(adjBase.conflicts);
    expect(adjWithUnbound.unbound).toEqual([
      { source: 'a-subpath', outcome: 'pass', reason: 'unknown-path' },
      { source: 'm-unknown', outcome: 'fail', reason: 'unknown-path' },
      { source: 'z-noclaim', outcome: 'fail', reason: 'no-claim' },
    ]);
  });

  test('5.7 Conflicts: two passing tools disagreeing, or pass + fail matching values (D25)', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', { ok: true, count: 10 }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', {
          ok: true,
          count: 10,
        }),
      },
      schema: z.object({ ok: z.boolean(), count: z.number() }),
      compare: { count: { tolerance: { absolute: 1 } } },
      prompt: 'Check',
    });

    const adj = await adjudicate(ledger, [
      {
        source: 'tool-b',
        outcome: 'pass',
        claim: { path: '/ok', value: true },
      },
      {
        source: 'tool-a',
        outcome: 'pass',
        claim: { path: '/ok', value: false },
      },
      {
        source: 'count-fail',
        outcome: 'fail',
        claim: { path: '/count', value: 10.5 },
      },
      {
        source: 'count-pass',
        outcome: 'pass',
        claim: { path: '/count', value: 10 },
      },
      {
        source: 'count-err',
        outcome: 'error',
        claim: { path: '/count', value: 10 },
      },
    ]);

    expect(adj.conflicts).toEqual([
      { path: '/count', sources: ['count-fail', 'count-pass'] },
      { path: '/ok', sources: ['tool-a', 'tool-b'] },
    ]);
  });

  test('5.8 Evidence order independence: shuffled evidence yields identical adjudication & fingerprint (I3)', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', { ok: true, score: 0.9 }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', {
          ok: false,
          score: 0.8,
        }),
      },
      schema: z.object({ ok: z.boolean(), score: z.number() }),
      compare: { score: { tolerance: { absolute: 0.05 } } },
      prompt: 'Check',
    });

    const list: Evidence[] = [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
      { source: 'tsc', outcome: 'pass', claim: { scope: 'artifact' } },
      { source: 'tool-1', outcome: 'pass', claim: { path: 'ok', value: true } },
      {
        source: 'tool-2',
        outcome: 'fail',
        claim: { path: '/ok', value: false },
      },
      {
        source: 'scorer',
        outcome: 'pass',
        claim: { path: '/score', value: 0.9 },
      },
      { source: 'misc', outcome: 'unknown' },
    ];
    const reversed = list.map((_v, i) => list[list.length - 1 - i]!);

    const a1 = await adjudicate(ledger, list);
    const a2 = await adjudicate(ledger, reversed);
    expect(a1).toEqual(a2);
    expect(a1.fingerprint).toBe(a2.fingerprint);
  });

  test('5.9 Invalid evidence throws DissentArgumentError("invalid-evidence") with index', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', { n: 1 }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', { n: 1 }),
      },
      schema: z.object({ n: z.number() }),
      prompt: 'Check',
    });

    const cases: Array<{ item: unknown; expectedArg: string }> = [
      {
        item: {
          source: 'tool',
          outcome: 'pass',
          claim: { path: '/n', value: Number.NaN },
        },
        expectedArg: 'evidence[0].claim.value',
      },
      {
        item: { source: 'tool', outcome: 'pass', details: { d: new Date() } },
        expectedArg: 'evidence[0].details',
      },
      {
        item: { source: 'tool', outcome: 'pass', claims: { bad: () => {} } },
        expectedArg: 'evidence[0].claims',
      },
      {
        item: { source: 'tool', outcome: 'bad-outcome' },
        expectedArg: 'evidence[0].outcome',
      },
      {
        item: { source: '   \u001b[2J  ', outcome: 'pass' },
        expectedArg: 'evidence[0].source',
      },
      {
        item: { source: 'x'.repeat(129), outcome: 'pass' },
        expectedArg: 'evidence[0].source',
      },
    ];

    for (const c of cases) {
      await expect(adjudicate(ledger, [c.item as Evidence])).rejects.toSatisfy(
        err => {
          return (
            DissentArgumentError.isInstance(err) &&
            err.code === 'invalid-evidence' &&
            err.argument === c.expectedArg
          );
        },
      );
    }

    // Second item index Check
    await expect(
      adjudicate(ledger, [
        { source: 'ok', outcome: 'pass' },
        { source: '', outcome: 'pass' },
      ]),
    ).rejects.toSatisfy(err => {
      return (
        DissentArgumentError.isInstance(err) &&
        err.code === 'invalid-evidence' &&
        err.argument === 'evidence[1].source'
      );
    });
  });

  test('5.10 validateOfflineReceipt failure reasons in order & requireOfflineReceipt fail-closed rule (D19)', async () => {
    expect(validateOfflineReceipt(null)).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(validateOfflineReceipt({ provider: 'p' })).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(validateOfflineReceipt(makeValidReceipt({ region: '' }))).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(
      validateOfflineReceipt(
        makeValidReceipt({ profile: 'other', networkPolicyEnforced: false }),
      ),
    ).toEqual({
      valid: false,
      reason: 'wrong-profile',
    });
    expect(
      validateOfflineReceipt(
        makeValidReceipt({ networkPolicyEnforced: false }),
        { networkPolicySha256: 'wrong' },
      ),
    ).toEqual({
      valid: false,
      reason: 'network-not-enforced',
    });
    expect(
      validateOfflineReceipt(makeValidReceipt(), {
        networkPolicySha256: 'sha256:other',
        runtimeImageDigest: 'sha256:other',
      }),
    ).toEqual({
      valid: false,
      reason: 'policy-mismatch',
    });
    expect(
      validateOfflineReceipt(makeValidReceipt(), {
        networkPolicySha256: 'sha256:policy-1',
        runtimeImageDigest: 'sha256:other',
      }),
    ).toEqual({
      valid: false,
      reason: 'image-mismatch',
    });
    expect(
      validateOfflineReceipt(makeValidReceipt(), {
        networkPolicySha256: 'sha256:policy-1',
        runtimeImageDigest: 'sha256:image-1',
      }),
    ).toEqual({ valid: true });

    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', { ok: true }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', { ok: true }),
      },
      schema: z.object({ ok: z.boolean() }),
      prompt: 'Check',
    });

    // Missing receipt with requireOfflineReceipt -> unknown / inconclusive
    const missingAdj = await adjudicate(
      ledger,
      [{ source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } }],
      { requireOfflineReceipt: true },
    );
    expect(missingAdj.verdict).toBe('uncertain');
    expect(missingAdj.verdictReason).toBe('artifact-evidence-inconclusive');
    expect(missingAdj.artifactEvidence).toEqual({
      pass: 0,
      fail: 0,
      error: 0,
      unknown: 1,
    });
    expect(missingAdj.receiptChecks).toEqual([
      {
        source: 'vitest',
        receiptId: null,
        check: { valid: false, reason: 'malformed' },
      },
    ]);

    // Valid receipt with requireOfflineReceipt -> confirmed
    const validAdj = await adjudicate(
      ledger,
      [
        {
          source: 'vitest',
          outcome: 'pass',
          claim: { scope: 'artifact' },
          receipt: makeValidReceipt(),
        },
      ],
      {
        requireOfflineReceipt: {
          networkPolicySha256: 'sha256:policy-1',
          runtimeImageDigest: 'sha256:image-1',
        },
      },
    );
    expect(validAdj.verdict).toBe('confirmed');
    expect(validAdj.verdictReason).toBe('artifact-evidence-passed');
    expect(validAdj.receiptChecks).toEqual([
      { source: 'vitest', receiptId: 'rcpt-100', check: { valid: true } },
    ]);

    // Failing item with invalid receipt maps to unknown, NOT fail (I12 / §10.5)
    const invalidFailAdj = await adjudicate(
      ledger,
      [
        {
          source: 'vitest',
          outcome: 'fail',
          claim: { scope: 'artifact' },
          receipt: makeValidReceipt({ networkPolicyEnforced: false }),
        },
      ],
      { requireOfflineReceipt: true },
    );
    expect(invalidFailAdj.verdict).toBe('uncertain');
    expect(invalidFailAdj.verdictReason).toBe('artifact-evidence-inconclusive');
    expect(invalidFailAdj.artifactEvidence).toEqual({
      pass: 0,
      fail: 0,
      error: 0,
      unknown: 1,
    });

    // Excluded witness stays silent even if present in ledger.witnesses
    const recordWithExcluded: Ledger<unknown, 'w1' | 'w2'> = {
      ...ledger,
      witnesses: {
        ...ledger.witnesses,
        w2: {
          requested: ledger.witnesses.w2.requested,
          served: null,
          status: 'excluded',
          stage: 'before-dispatch',
          match: { authorModel: 'anthropic/claude-sonnet-4', on: 'requested' },
          durationMs: 0,
          usage: null,
        } satisfies WitnessRecord<unknown>,
      },
    };
    const excludedAdj = await adjudicate(recordWithExcluded, [
      { source: 'tool', outcome: 'pass', claim: { path: '/ok', value: true } },
    ]);
    expect(excludedAdj.settlements[0]?.witnessesSilent).toEqual(['w2']);

    // Unknown keys in options and requireOfflineReceipt throw fail-closed invalid-option
    await expect(
      adjudicate(ledger, [], {
        escalateOnReview: false,
        extraKey: true,
      } as unknown as Parameters<typeof adjudicate>[2]),
    ).rejects.toSatisfy(
      err =>
        DissentArgumentError.isInstance(err) &&
        err.code === 'invalid-option' &&
        err.argument === 'options.extraKey',
    );

    await expect(
      adjudicate(ledger, [], {
        requireOfflineReceipt: {
          networkPolicySHA256: 'sha256:policy-1',
        } as unknown as { networkPolicySha256?: string },
      }),
    ).rejects.toSatisfy(
      err =>
        DissentArgumentError.isInstance(err) &&
        err.code === 'invalid-option' &&
        err.argument === 'requireOfflineReceipt.networkPolicySHA256',
    );

    // Empty requireOfflineReceipt object normalizes identically to `true` (fingerprint parity)
    const ev = [
      {
        source: 'vitest',
        outcome: 'pass' as const,
        claim: { scope: 'artifact' as const },
        receipt: makeValidReceipt(),
      },
    ];
    const reqTrue = await adjudicate(ledger, ev, {
      requireOfflineReceipt: true,
    });
    const reqEmptyObj = await adjudicate(ledger, ev, {
      requireOfflineReceipt: {},
    });
    const reqUndefinedFields = await adjudicate(ledger, ev, {
      requireOfflineReceipt: {
        networkPolicySha256: undefined,
        runtimeImageDigest: undefined,
      },
    } as unknown as Parameters<typeof adjudicate>[2]);
    expect(reqEmptyObj).toEqual(reqTrue);
    expect(reqUndefinedFields).toEqual(reqTrue);
  });

  test('5.11 claims and receipt change fingerprint but not verdict (D20)', async () => {
    const ledger = await corroborate({
      witnesses: {
        w1: makeWitnessModel('openai/gpt-4o', { ok: true }),
        w2: makeWitnessModel('anthropic/claude-sonnet-4', { ok: true }),
      },
      schema: z.object({ ok: z.boolean() }),
      prompt: 'Check',
    });

    const base = await adjudicate(ledger, [
      { source: 'vitest', outcome: 'pass', claim: { scope: 'artifact' } },
    ]);
    const withClaims = await adjudicate(ledger, [
      {
        source: 'vitest',
        outcome: 'pass',
        claim: { scope: 'artifact' },
        claims: { exitCode: 0 },
      },
    ]);
    const withReceipt = await adjudicate(ledger, [
      {
        source: 'vitest',
        outcome: 'pass',
        claim: { scope: 'artifact' },
        receipt: makeValidReceipt(),
      },
    ]);

    expect(withClaims.verdict).toBe(base.verdict);
    expect(withReceipt.verdict).toBe(base.verdict);
    expect(withClaims.fingerprint).not.toBe(base.fingerprint);
    expect(withReceipt.fingerprint).not.toBe(base.fingerprint);
    expect(withClaims.fingerprint).not.toBe(withReceipt.fingerprint);
  });
});
