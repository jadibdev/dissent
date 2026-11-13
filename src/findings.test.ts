import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalJson, compareUtf16 } from './canonical/canonical-json.js';
import { compareFields } from './compare/compare-fields.js';
import { computeCoverage } from './compare/coverage.js';
import { buildPlanFields, derivePlan } from './compare/derive-plan.js';
import {
  collectComparisonFindings,
  compareFindings,
  computeAdvisory,
  sortFindings,
} from './findings.js';
import type { FieldPlan, FieldResult, Finding, JSONValue } from './types.js';

function assertSortedBy<T>(
  items: ReadonlyArray<T>,
  cmp: (a: T, b: T) => number,
  label: string,
): void {
  for (let i = 1; i < items.length; i++) {
    expect(
      cmp(items[i - 1]!, items[i]!),
      `${label} unsorted at index ${i}`,
    ).toBeLessThanOrEqual(0);
  }
}

function assertAllArraysSorted<W extends string>(
  planFields: Record<string, FieldPlan>,
  fields: Record<string, FieldResult<W>>,
  byReason: Record<string, number>,
  findings: ReadonlyArray<Finding<W>>,
): void {
  assertSortedBy(Object.keys(planFields), compareUtf16, 'plan.fields keys');
  assertSortedBy(Object.keys(fields), compareUtf16, 'fields keys');
  assertSortedBy(Object.keys(byReason), compareUtf16, 'coverage.byReason keys');
  assertSortedBy(findings, compareFindings, 'findings');

  for (const fieldKey of Object.keys(fields)) {
    const res = Object.getOwnPropertyDescriptor(fields, fieldKey)
      ?.value as FieldResult<W>;
    assertSortedBy(res.presented, compareUtf16, `${fieldKey}.presented`);
    assertSortedBy(res.missing, compareUtf16, `${fieldKey}.missing`);
    assertSortedBy(res.nulls, compareUtf16, `${fieldKey}.nulls`);

    if (res.comparator === 'exact') {
      assertSortedBy(
        res.groups,
        (a, b) => compareUtf16(canonicalJson(a.value), canonicalJson(b.value)),
        `${fieldKey}.groups`,
      );
      for (const g of res.groups) {
        assertSortedBy(
          g.witnesses,
          compareUtf16,
          `${fieldKey}.group.witnesses`,
        );
      }
    } else if (res.comparator === 'tolerance') {
      assertSortedBy(
        res.groups,
        (a, b) => a.min - b.min,
        `${fieldKey}.tolerance.groups`,
      );
      for (const g of res.groups) {
        assertSortedBy(
          g.values,
          (a, b) => (a.value as number) - (b.value as number),
          `${fieldKey}.tolerance.group.values`,
        );
        for (const v of g.values) {
          assertSortedBy(
            v.witnesses,
            compareUtf16,
            `${fieldKey}.tolerance.value.witnesses`,
          );
        }
      }
      if (res.nullGroup !== undefined) {
        assertSortedBy(
          res.nullGroup.witnesses,
          compareUtf16,
          `${fieldKey}.nullGroup.witnesses`,
        );
      }
    } else if (res.comparator === 'set') {
      assertSortedBy(
        res.union,
        (a, b) => compareUtf16(canonicalJson(a), canonicalJson(b)),
        `${fieldKey}.union`,
      );
      assertSortedBy(
        res.intersection,
        (a, b) => compareUtf16(canonicalJson(a), canonicalJson(b)),
        `${fieldKey}.intersection`,
      );
      assertSortedBy(
        res.items,
        (a, b) => compareUtf16(canonicalJson(a.item), canonicalJson(b.item)),
        `${fieldKey}.items`,
      );
      for (const item of res.items) {
        assertSortedBy(
          item.witnesses,
          compareUtf16,
          `${fieldKey}.item.witnesses`,
        );
      }
      assertSortedBy(res.duplicates, compareUtf16, `${fieldKey}.duplicates`);
    } else if (res.comparator === 'keyed-set') {
      assertSortedBy(
        res.keys.union,
        (a, b) => compareUtf16(canonicalJson(a), canonicalJson(b)),
        `${fieldKey}.keys.union`,
      );
      assertSortedBy(
        res.keys.intersection,
        (a, b) => compareUtf16(canonicalJson(a), canonicalJson(b)),
        `${fieldKey}.keys.intersection`,
      );
      assertSortedBy(
        res.items,
        (a, b) => compareUtf16(canonicalJson(a.key), canonicalJson(b.key)),
        `${fieldKey}.keyed.items`,
      );
      for (const item of res.items) {
        assertSortedBy(
          item.witnesses,
          compareUtf16,
          `${fieldKey}.key.witnesses`,
        );
        assertSortedBy(
          Object.keys(item.fields),
          compareUtf16,
          `${fieldKey}.key.fields`,
        );
      }
    } else if (res.comparator === 'discriminated-union') {
      assertSortedBy(
        res.choice.groups,
        (a, b) => compareUtf16(canonicalJson(a.value), canonicalJson(b.value)),
        `${fieldKey}.choice.groups`,
      );
      assertSortedBy(
        res.branches,
        (a, b) => compareUtf16(canonicalJson(a.value), canonicalJson(b.value)),
        `${fieldKey}.branches`,
      );
      for (const br of res.branches) {
        assertSortedBy(
          br.witnesses,
          compareUtf16,
          `${fieldKey}.branch.witnesses`,
        );
        assertSortedBy(
          Object.keys(br.fields),
          compareUtf16,
          `${fieldKey}.branch.fields`,
        );
      }
    } else {
      assertSortedBy(
        res.values,
        (a, b) => compareUtf16(a.witness, b.witness),
        `${fieldKey}.values`,
      );
      if (res.duplicateKeyWitnesses !== undefined) {
        assertSortedBy(
          res.duplicateKeyWitnesses,
          compareUtf16,
          `${fieldKey}.duplicateKeyWitnesses`,
        );
      }
    }
  }
}

describe('findings, coverage, advisory, and Layer B invariants', () => {
  it('3.5 DeepSeek torture fixture handles refs, unsupported shapes, null vs missing, and coverage-low (I10, I14)', () => {
    const tortureSchema = {
      $defs: {
        LocalRisk: {
          type: 'object',
          properties: {
            level: { enum: ['low', 'high'] },
          },
        },
      },
      type: 'object',
      properties: {
        local: { $ref: '#/$defs/LocalRisk' },
        ext: { $ref: 'https://example.com/external.json' },
        union3: {
          anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
        },
        rec: { type: 'object', additionalProperties: { type: 'string' } },
        tup: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'integer' }],
        },
        nullableFlag: { type: ['boolean', 'null'] },
        optCount: { type: 'integer' },
      },
    };

    const plan = buildPlanFields(tortureSchema);
    const fields = compareFields(plan, {
      w1: {
        local: { level: 'low' },
        ext: { x: 1 },
        union3: 'abc',
        rec: { a: 'b' },
        tup: ['x', 1],
        nullableFlag: true,
        optCount: 5,
      },
      w2: {
        local: { level: 'low' },
        ext: { x: 1 },
        union3: 'abc',
        rec: { a: 'b' },
        tup: ['x', 1],
        nullableFlag: null,
      },
    });

    expect(fields['/local/level']?.status).toBe('agree');
    for (const unsupKey of ['/ext', '/union3', '/rec', '/tup']) {
      expect(fields[unsupKey]?.status).toBe('not-compared');
      expect(fields[unsupKey]?.status).not.toBe('agree');
    }

    expect(fields['/nullableFlag']).toMatchObject({
      status: 'split',
      presented: ['w1', 'w2'],
      nulls: ['w2'],
      missing: [],
    });
    expect(fields['/optCount']).toMatchObject({
      status: 'insufficient',
      presented: ['w1'],
      missing: ['w2'],
      nulls: [],
    });

    const cov = computeCoverage(plan, fields);
    expect(cov.unsupported).toBe(4);
    expect(cov.compared).toBe(3); // /local/level, /nullableFlag, /optCount
    expect(cov.ratio).toBeLessThan(1);

    const findings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: fields,
      coverage: cov,
    });
    expect(findings.filter(f => f.code === 'coverage-low')).toHaveLength(1);
    const unsupFindings = findings.filter(f => f.code === 'unsupported-schema');
    expect(unsupFindings.map(f => f.path)).toEqual([
      '/ext',
      '/rec',
      '/tup',
      '/union3',
    ]);
  });

  it('3.13 emits findings under exact conditions/severities and suppresses field-level findings when answered < 2 (I13, I14)', () => {
    const schema = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        ext: { $ref: 'https://example.com/e.json' },
        branching: {
          oneOf: [
            {
              type: 'object',
              required: ['k', 'bad'],
              properties: { k: { const: 'a' }, bad: {} },
            },
            {
              type: 'object',
              required: ['k', 'good'],
              properties: { k: { const: 'b' }, good: { type: 'integer' } },
            },
          ],
        },
      },
    };
    const plan = buildPlanFields(schema);
    const oneWitnessFields = compareFields(plan, {
      only: { ok: true, branching: { k: 'b', good: 1 } },
    });
    const cov = computeCoverage(plan, oneWitnessFields);

    const lowQuorumFindings = collectComparisonFindings({
      answered: 1,
      planFields: plan,
      fieldResults: oneWitnessFields,
      coverage: cov,
      strictCoverage: false,
    });

    expect(lowQuorumFindings[0]).toEqual({
      code: 'insufficient-quorum',
      severity: 'critical',
      data: { answered: 1 },
    });
    expect(
      lowQuorumFindings.some(
        f =>
          f.code === 'field-split' ||
          f.code === 'field-partial' ||
          f.code === 'duplicate-key',
      ),
    ).toBe(false);
    // unsupported-schema (top level & union branch) and coverage-low are still emitted
    expect(
      lowQuorumFindings.filter(f => f.code === 'unsupported-schema'),
    ).toEqual([
      {
        code: 'unsupported-schema',
        severity: 'warn',
        path: '/branching',
        within: { branch: 'a' },
        subpath: '/bad',
        data: { detail: 'untyped' },
      },
      {
        code: 'unsupported-schema',
        severity: 'warn',
        path: '/ext',
        data: { detail: 'external-ref' },
      },
    ]);
    expect(
      lowQuorumFindings.find(f => f.code === 'coverage-low')?.severity,
    ).toBe('warn');

    const strictFindings = collectComparisonFindings({
      answered: 1,
      planFields: plan,
      fieldResults: oneWitnessFields,
      coverage: cov,
      strictCoverage: true,
    });
    expect(strictFindings.find(f => f.code === 'coverage-low')?.severity).toBe(
      'critical',
    );
    expect(computeAdvisory(strictFindings)).toBe('review-required');
  });

  it('3.14 computeAdvisory maps severities accurately (I13)', () => {
    expect(computeAdvisory([])).toBe('clear');
    expect(
      computeAdvisory([
        { code: 'witness-excluded', severity: 'info' },
        { code: 'truncated-output', severity: 'info', witnesses: ['a'] },
      ]),
    ).toBe('clear');
    expect(
      computeAdvisory([
        { code: 'witness-excluded', severity: 'info' },
        {
          code: 'field-partial',
          severity: 'warn',
          path: '/a',
          witnesses: ['b'],
        },
      ]),
    ).toBe('warnings');
    expect(
      computeAdvisory([
        {
          code: 'field-partial',
          severity: 'warn',
          path: '/a',
          witnesses: ['b'],
        },
        {
          code: 'field-split',
          severity: 'critical',
          path: '/b',
          witnesses: ['a', 'b'],
        },
      ]),
    ).toBe('review-required');

    // Canonical sorting of mixed findings
    const unsorted: Finding[] = [
      { code: 'truncated-output', severity: 'info', witnesses: ['b'] },
      { code: 'field-partial', severity: 'warn', path: '/z', witnesses: ['a'] },
      {
        code: 'field-split',
        severity: 'critical',
        path: '/a',
        witnesses: ['a', 'b'],
      },
      {
        code: 'coverage-low',
        severity: 'warn',
        data: { compared: 1, fields: 2, ratio: 0.5 },
      },
    ];
    const sorted = sortFindings(unsorted);
    expect(sorted.map(f => f.code)).toEqual([
      'field-split',
      'coverage-low',
      'field-partial',
      'truncated-output',
    ]);
  });

  it('3.15 coverage arithmetic and free-text-only ratio = 1 without coverage-low (D8)', () => {
    const freeTextSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        score: { type: 'number' },
      },
    };
    const freePlan = buildPlanFields(freeTextSchema);
    const freeFields = compareFields(freePlan, {
      a: { summary: 'x', score: 1.5 },
      b: { summary: 'y', score: 2.5 },
    });
    const freeCov = computeCoverage(freePlan, freeFields);
    expect(freeCov).toEqual({
      fields: 2,
      compared: 0,
      notComparedByPolicy: 2,
      unsupported: 0,
      failedAtRuntime: 0,
      ratio: 1,
      byReason: { 'free-text': 1, 'number-without-tolerance': 1 },
    });
    const freeFindings = collectComparisonFindings({
      answered: 2,
      planFields: freePlan,
      fieldResults: freeFields,
      coverage: freeCov,
    });
    expect(freeFindings).toEqual([]);

    // Mixed schema accounting: fields = compared + notComparedByPolicy + unsupported + failedAtRuntime
    const mixedSchema = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        note: { type: 'string' },
        ext: { $ref: 'https://example.com/a.json' },
        union: {
          oneOf: [
            {
              type: 'object',
              required: ['k', 'v'],
              properties: { k: { const: 'x' }, v: { type: 'integer' } },
            },
            {
              type: 'object',
              required: ['k', 'w'],
              properties: { k: { const: 'y' }, w: {} },
            },
          ],
        },
      },
    };
    const mixedPlan = buildPlanFields(mixedSchema);
    const mixedFields = compareFields(mixedPlan, {
      a: { ok: true, note: 'hi', union: { k: 'x', v: 1 } },
      b: { ok: true, note: 'bye', union: { k: 'x', v: 1 } },
    });
    const mixedCov = computeCoverage(mixedPlan, mixedFields);
    // ok (compared), note (policy), ext (unsupported), union choice (compared) + branch x leaf v (compared) + branch y leaf w (unsupported)
    expect(mixedCov.compared).toBe(3);
    expect(mixedCov.notComparedByPolicy).toBe(1);
    expect(mixedCov.unsupported).toBe(2);
    expect(mixedCov.failedAtRuntime).toBe(0);
    expect(mixedCov.fields).toBe(
      mixedCov.compared +
        mixedCov.notComparedByPolicy +
        mixedCov.unsupported +
        mixedCov.failedAtRuntime,
    );
    expect(mixedCov.ratio).toBe(3 / 5);
  });

  it('3.16 property test: 200 seeded permutations yield byte-identical plan, fields, coverage, findings, and advisory (I3)', async () => {
    const schema = {
      type: 'object',
      properties: {
        flag: { type: 'boolean' },
        score: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'risk'],
            properties: {
              id: { type: 'string' },
              risk: { enum: ['low', 'high'] },
              note: { type: 'string' },
            },
          },
        },
        event: {
          oneOf: [
            {
              type: 'object',
              required: ['type', 'code'],
              properties: { type: { const: 'err' }, code: { type: 'integer' } },
            },
            {
              type: 'object',
              required: ['type', 'ok'],
              properties: { type: { const: 'ok' }, ok: { type: 'boolean' } },
            },
          ],
        },
      },
    };

    const baseWitnesses: Array<{
      label: string;
      output: Record<string, JSONValue>;
    }> = [
      {
        label: 'w_beta',
        output: {
          flag: true,
          score: 0.72,
          tags: ['x', 'y', 'x'],
          items: [
            { id: 'f1', risk: 'low', note: 'clean' },
            { id: 'f2', risk: 'high', note: 'issue' },
          ],
          event: { type: 'err', code: 500 },
        },
      },
      {
        label: 'w_alpha',
        output: {
          flag: false,
          score: 0.7,
          tags: ['y', 'z'],
          items: [
            { id: 'f2', risk: 'low', note: 'minor' },
            { id: 'f1', risk: 'low', note: 'ok' },
          ],
          event: { type: 'err', code: 502 },
        },
      },
      {
        label: 'w_gamma',
        output: {
          flag: true,
          score: 0.85,
          tags: ['z', 'x'],
          items: [{ id: 'f1', risk: 'low', note: 'fine' }],
          event: { type: 'ok', ok: true },
        },
      },
    ];

    const baselinePlan = await derivePlan(schema, {
      score: { tolerance: { absolute: 0.05 } },
      items: { key: 'id' },
    });
    const baselineFields = compareFields(
      baselinePlan.fields,
      Object.fromEntries(baseWitnesses.map(w => [w.label, w.output])),
    );
    const baselineCov = computeCoverage(baselinePlan.fields, baselineFields);
    const baselineFindings = collectComparisonFindings({
      answered: baseWitnesses.length,
      planFields: baselinePlan.fields,
      fieldResults: baselineFields,
      coverage: baselineCov,
    });
    const baselineAdvisory = computeAdvisory(baselineFindings);

    const baselineSnapshot = canonicalJson({
      plan: baselinePlan,
      fields: baselineFields,
      coverage: baselineCov,
      findings: baselineFindings,
      advisory: baselineAdvisory,
    });

    // Mulberry32 deterministic PRNG
    let seed = 0x1234abcd;
    function nextRand(): number {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function shuffle<T>(arr: readonly T[]): T[] {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(nextRand() * (i + 1));
        const tmp = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = tmp;
      }
      return copy;
    }

    function permuteObject(
      obj: Record<string, JSONValue>,
    ): Record<string, JSONValue> {
      const keys = shuffle(Object.keys(obj));
      const out: Record<string, JSONValue> = {};
      for (const k of keys) {
        const val = obj[k]!;
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          out[k] = permuteObject(val as Record<string, JSONValue>);
        } else {
          out[k] = val;
        }
      }
      return out;
    }

    for (let iter = 0; iter < 200; iter++) {
      const permutedOverrides =
        nextRand() < 0.5
          ? {
              score: { tolerance: { absolute: 0.05 } },
              items: { key: 'id' },
            }
          : {
              items: { key: 'id' },
              score: { tolerance: { absolute: 0.05 } },
            };
      const plan = await derivePlan(schema, permutedOverrides);

      const permutedWitnesses = shuffle(baseWitnesses).map(w => {
        const cloned: Record<string, JSONValue> = {
          ...w.output,
          tags: shuffle(w.output['tags'] as JSONValue[]),
          items: shuffle(w.output['items'] as Record<string, JSONValue>[]).map(
            item => permuteObject(item),
          ),
        };
        return {
          witness: w.label,
          output: permuteObject(cloned),
        };
      });

      const fields = compareFields(plan.fields, permutedWitnesses);
      const coverage = computeCoverage(plan.fields, fields);
      const findings = collectComparisonFindings({
        answered: permutedWitnesses.length,
        planFields: plan.fields,
        fieldResults: fields,
        coverage,
      });
      const advisory = computeAdvisory(findings);

      expect(
        canonicalJson({ plan, fields, coverage, findings, advisory }),
      ).toBe(baselineSnapshot);
    }
  });

  it('3.17 validates every documented array and key ordering across Layer B outputs (I3d)', () => {
    const schema = {
      type: 'object',
      properties: {
        zeta: { type: 'boolean' },
        alpha: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        num: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'score'],
            properties: {
              id: { type: 'string' },
              score: { type: 'integer' },
            },
          },
        },
        union: {
          oneOf: [
            {
              type: 'object',
              required: ['kind', 'x'],
              properties: { kind: { const: 'b' }, x: { type: 'integer' } },
            },
            {
              type: 'object',
              required: ['kind', 'y'],
              properties: { kind: { const: 'a' }, y: { type: 'boolean' } },
            },
          ],
        },
        unsup: { $ref: 'https://example.com/u.json' },
      },
    };
    const plan = buildPlanFields(schema, {
      num: { tolerance: { absolute: 1 } },
      items: { key: 'id' },
    });
    const fields = compareFields(plan, {
      w_z: {
        zeta: true,
        alpha: 2,
        tags: ['z', 'a', 'z'],
        num: 20,
        items: [
          { id: 'k2', score: 1 },
          { id: 'k1', score: 2 },
        ],
        union: { kind: 'b', x: 1 },
      },
      w_a: {
        zeta: false,
        alpha: 1,
        tags: ['b', 'a'],
        num: 10,
        items: [{ id: 'k1', score: 3 }],
        union: { kind: 'a', y: true },
      },
    });
    const cov = computeCoverage(plan, fields);
    const findings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: fields,
      coverage: cov,
    });

    assertAllArraysSorted(plan, fields, cov.byReason, findings);
  });

  it('3.19 Layer purity: non-test files in compare/, canonical/, findings.ts, paths.ts, errors.ts, types.ts contain no external value imports or Node globals (I16)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const targets: string[] = [];

    function walkDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.test-d.ts')
        ) {
          targets.push(full);
        }
      }
    }

    walkDir(path.join(here, 'compare'));
    walkDir(path.join(here, 'canonical'));
    for (const single of ['findings.ts', 'paths.ts', 'errors.ts', 'types.ts']) {
      targets.push(path.join(here, single));
    }

    expect(targets.length).toBeGreaterThanOrEqual(8);

    const valueImportRe =
      /^\s*import\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    const anyNodeImportRe = /from\s+['"]node:[^'"]+['"]/;
    const forbiddenGlobalRe =
      /\b(?:Buffer|process|require|__dirname|__filename|document|window|localStorage)\b/;

    for (const file of targets) {
      const content = fs.readFileSync(file, 'utf8');
      expect(anyNodeImportRe.test(content), `node: import in ${file}`).toBe(
        false,
      );

      valueImportRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = valueImportRe.exec(content)) !== null) {
        const spec = match[1]!;
        expect(
          spec.startsWith('./') || spec.startsWith('../'),
          `external value import "${spec}" in ${file}`,
        ).toBe(true);
      }

      // Strip single-line and block comments before checking global identifiers
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(
        forbiddenGlobalRe.test(stripped),
        `forbidden Node/DOM global in ${file}`,
      ).toBe(false);
    }
  });
});
