import { describe, expect, it } from 'vitest';

import { collectComparisonFindings } from '../findings.js';
import type { JSONValue } from '../types.js';
import { compareFields } from './compare-fields.js';
import { computeCoverage } from './coverage.js';
import { buildPlanFields } from './derive-plan.js';
import { withinTolerance } from './tolerance.js';

describe('comparators (Layer B)', () => {
  it('3.7 exact comparator: agree, 2-1 split sorted by canonical value, null group, and missing witness (I2, I10)', () => {
    const schema = {
      type: 'object',
      properties: {
        verdict: { enum: ['alpha', 'beta', 'gamma'] },
        optFlag: { type: ['boolean', 'null'] },
      },
    };
    const plan = buildPlanFields(schema);
    const fields = compareFields(plan, {
      w1: { verdict: 'beta', optFlag: true },
      w2: { verdict: 'alpha', optFlag: null },
      w3: { verdict: 'beta' },
    });

    const verdictRes = fields['/verdict'];
    expect(verdictRes).toEqual({
      comparator: 'exact',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2', 'w3'],
      missing: [],
      nulls: [],
      groups: [
        { value: 'alpha', witnesses: ['w2'], support: 1 },
        { value: 'beta', witnesses: ['w1', 'w3'], support: 2 },
      ],
    });

    const optFlagRes = fields['/optFlag'];
    expect(optFlagRes).toEqual({
      comparator: 'exact',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2'],
      missing: ['w3'],
      nulls: ['w2'],
      groups: [
        { value: null, witnesses: ['w2'], support: 1 },
        { value: true, witnesses: ['w1'], support: 1 },
      ],
    });

    // Missing witness does not break agree when 2 presenters agree, but emits field-partial
    const agreeFields = compareFields(plan, {
      w1: { verdict: 'alpha', optFlag: false },
      w2: { verdict: 'alpha', optFlag: false },
      w3: { verdict: 'alpha' },
    });
    expect(agreeFields['/verdict']?.status).toBe('agree');
    expect(agreeFields['/optFlag']).toMatchObject({
      status: 'agree',
      answered: 3,
      presented: ['w1', 'w2'],
      missing: ['w3'],
      nulls: [],
    });

    const cov = computeCoverage(plan, agreeFields);
    const findings = collectComparisonFindings({
      answered: 3,
      planFields: plan,
      fieldResults: agreeFields,
      coverage: cov,
    });
    expect(findings).toEqual([
      {
        code: 'field-partial',
        severity: 'warn',
        path: '/optFlag',
        witnesses: ['w3'],
      },
    ]);
  });

  it('3.8 tolerance comparator: abs, rel, both, chained single-linkage split, nullGroup, min/max/spread (D10)', () => {
    expect(withinTolerance(1.0, 1.25, { absolute: 0.25 })).toBe(true);
    expect(withinTolerance(1.0, 1.04, { absolute: 0.05 })).toBe(true);
    // IEEE-754 double difference |1.05 - 1.0| = 0.050000000000000044 > 0.05 (never rounded)
    expect(withinTolerance(1.0, 1.05, { absolute: 0.05 })).toBe(false);
    expect(withinTolerance(100, 109, { relative: 0.1 })).toBe(true);
    expect(withinTolerance(100, 111, { absolute: 2, relative: 0.1 })).toBe(
      true,
    );

    const schema = {
      type: 'object',
      properties: {
        absOnly: { type: 'number' },
        relOnly: { type: 'number' },
        both: { type: ['number', 'null'] },
      },
    };
    const plan = buildPlanFields(schema, {
      absOnly: { tolerance: { absolute: 0.05 } },
      relOnly: { tolerance: { relative: 0.1 } },
      both: { tolerance: { absolute: 1, relative: 0.05 } },
    });

    // Chained 1.00 / 1.04 / 1.08 with abs 0.05 -> split with 1 single-linkage group!
    const fields = compareFields(plan, {
      a: { absOnly: 1.04, relOnly: 100, both: -0 },
      b: { absOnly: 1.0, relOnly: 105, both: null },
      c: { absOnly: 1.08, relOnly: 108, both: 0 },
    });

    expect(fields['/absOnly']).toEqual({
      comparator: 'tolerance',
      status: 'split',
      answered: 3,
      presented: ['a', 'b', 'c'],
      missing: [],
      nulls: [],
      tolerance: { absolute: 0.05 },
      min: 1.0,
      max: 1.08,
      spread: 1.08 - 1.0,
      groups: [
        {
          min: 1.0,
          max: 1.08,
          support: 3,
          values: [
            { value: 1.0, witnesses: ['b'], support: 1 },
            { value: 1.04, witnesses: ['a'], support: 1 },
            { value: 1.08, witnesses: ['c'], support: 1 },
          ],
        },
      ],
    });

    expect(fields['/relOnly']?.status).toBe('agree');
    expect(fields['/both']).toEqual({
      comparator: 'tolerance',
      status: 'split',
      answered: 3,
      presented: ['a', 'b', 'c'],
      missing: [],
      nulls: ['b'],
      tolerance: { absolute: 1, relative: 0.05 },
      min: 0,
      max: 0,
      spread: 0,
      groups: [
        {
          min: 0,
          max: 0,
          support: 2,
          values: [{ value: 0, witnesses: ['a', 'c'], support: 2 }],
        },
      ],
      nullGroup: { witnesses: ['b'], support: 1 },
    });

    // Separate linkage clusters when gap exceeds tolerance
    const multiCluster = compareFields(
      buildPlanFields(
        {
          type: 'object',
          properties: { x: { type: 'number' } },
        },
        { x: { tolerance: { absolute: 1 } } },
      ),
      { w1: { x: 10 }, w2: { x: 10.5 }, w3: { x: 20 } },
    );
    const xRes = multiCluster['/x'];
    expect(xRes?.comparator).toBe('tolerance');
    if (xRes?.comparator === 'tolerance') {
      expect(xRes.status).toBe('split');
      expect(xRes.groups).toHaveLength(2);
      expect(xRes.min).toBe(10);
      expect(xRes.max).toBe(20);
      expect(xRes.spread).toBe(10);
    }
  });

  it('3.9 set comparator: order-insensitive, duplicates, jaccard, empty agree, null vs [] split (I3)', () => {
    const schema = {
      type: 'object',
      properties: {
        agreeOrder: { type: 'array', items: { type: 'string' } },
        splitTags: { type: 'array', items: { type: 'string' } },
        emptyArr: { type: 'array', items: { type: 'integer' } },
        nullableArr: { type: ['array', 'null'], items: { type: 'string' } },
      },
    };
    const plan = buildPlanFields(schema);
    const fields = compareFields(plan, {
      a: {
        agreeOrder: ['b', 'a', 'b'],
        splitTags: ['a', 'b'],
        emptyArr: [],
        nullableArr: null,
      },
      b: {
        agreeOrder: ['a', 'b'],
        splitTags: ['b', 'a'],
        emptyArr: [],
        nullableArr: [],
      },
      c: {
        agreeOrder: ['b', 'a'],
        splitTags: ['a', 'c'],
        emptyArr: [],
        nullableArr: [],
      },
    });

    expect(fields['/agreeOrder']).toEqual({
      comparator: 'set',
      status: 'agree',
      answered: 3,
      presented: ['a', 'b', 'c'],
      missing: [],
      nulls: [],
      union: ['a', 'b'],
      intersection: ['a', 'b'],
      items: [
        { item: 'a', witnesses: ['a', 'b', 'c'], support: 3 },
        { item: 'b', witnesses: ['a', 'b', 'c'], support: 3 },
      ],
      jaccard: 1,
      duplicates: ['a'],
    });

    expect(fields['/splitTags']).toMatchObject({
      comparator: 'set',
      status: 'split',
      union: ['a', 'b', 'c'],
      intersection: ['a'],
      jaccard: 1 / 3,
      duplicates: [],
    });

    expect(fields['/emptyArr']).toMatchObject({
      comparator: 'set',
      status: 'agree',
      union: [],
      intersection: [],
      jaccard: 1,
    });

    expect(fields['/nullableArr']).toMatchObject({
      comparator: 'set',
      status: 'split',
      nulls: ['a'],
      union: [],
      intersection: [],
    });
  });

  it('3.9b set comparator treats present non-null non-array value as distinct presented split (I1)', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        emptyTags: { type: 'array', items: { type: 'string' } },
      },
    };
    const plan = buildPlanFields(schema);
    const fields = compareFields(plan, {
      w1: { tags: ['a'], emptyTags: [] },
      w2: { tags: ['a'], emptyTags: [] },
      w3: { tags: 'oops', emptyTags: 'oops' },
    });

    expect(fields['/tags']).toEqual({
      comparator: 'set',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2', 'w3'],
      missing: [],
      nulls: [],
      union: ['a'],
      intersection: [],
      items: [{ item: 'a', witnesses: ['w1', 'w2'], support: 2 }],
      jaccard: 0,
      duplicates: [],
    });

    expect(fields['/emptyTags']).toEqual({
      comparator: 'set',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2', 'w3'],
      missing: [],
      nulls: [],
      union: [],
      intersection: [],
      items: [],
      jaccard: 0,
      duplicates: [],
    });

    const findings = collectComparisonFindings({
      answered: 3,
      planFields: plan,
      fieldResults: fields,
      coverage: computeCoverage(plan, fields),
    });
    expect(findings).toEqual([
      {
        code: 'field-split',
        severity: 'warn',
        path: '/emptyTags',
        witnesses: ['w1', 'w2', 'w3'],
      },
      {
        code: 'field-split',
        severity: 'warn',
        path: '/tags',
        witnesses: ['w1', 'w2', 'w3'],
      },
    ]);
  });

  it('3.10 keyed-set comparator: matched item fields, key-set split, duplicate-key handling and coverage (D12, I14)', () => {
    const schema = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'note'],
            properties: {
              path: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
      },
    };
    const plan = buildPlanFields(schema, { files: { key: 'path' } });

    // Key sets differ -> split + container field-split
    const differing = compareFields(plan, {
      a: { files: [{ path: 'a.ts', note: 'first' }] },
      b: {
        files: [
          { path: 'a.ts', note: 'second' },
          { path: 'b.ts', note: 'extra' },
        ],
      },
    });
    expect(differing['/files']).toMatchObject({
      comparator: 'keyed-set',
      status: 'split',
      key: 'path',
      keys: {
        union: ['a.ts', 'b.ts'],
        intersection: ['a.ts'],
        jaccard: 0.5,
      },
    });
    const covDiff = computeCoverage(plan, differing);
    const diffFindings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: differing,
      coverage: covDiff,
    });
    expect(diffFindings).toContainEqual({
      code: 'field-split',
      severity: 'warn',
      path: '/files',
      witnesses: ['a', 'b'],
    });

    // Duplicate key in witness -> duplicate-key result, finding, failedAtRuntime = 1, coverage-low
    const dupFields = compareFields(plan, {
      a: {
        files: [
          { path: 'a.ts', note: '1' },
          { path: 'a.ts', note: '2' },
        ],
      },
      b: { files: [{ path: 'a.ts', note: 'ok' }] },
    });
    expect(dupFields['/files']).toMatchObject({
      comparator: 'none',
      status: 'not-compared',
      reason: 'duplicate-key',
      detail: 'duplicate-key',
      duplicateKeyWitnesses: ['a'],
    });

    const dupCov = computeCoverage(plan, dupFields);
    expect(dupCov.failedAtRuntime).toBe(1);
    expect(dupCov.compared).toBe(0);
    expect(dupCov.notComparedByPolicy).toBe(1);
    expect(dupCov.byReason['duplicate-key']).toBe(1);

    const dupFindings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: dupFields,
      coverage: dupCov,
    });
    expect(dupFindings.some(f => f.code === 'duplicate-key')).toBe(true);
    expect(dupFindings.some(f => f.code === 'coverage-low')).toBe(true);

    // Keyed-set with a compared item field + duplicate key: item field is also counted under failedAtRuntime
    const schemaWithComparedLeaf = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'approved'],
            properties: {
              path: { type: 'string' },
              approved: { type: 'boolean' },
            },
          },
        },
      },
    };
    const planWithLeaf = buildPlanFields(schemaWithComparedLeaf, {
      files: { key: 'path' },
    });
    const dupLeafFields = compareFields(planWithLeaf, {
      a: {
        files: [
          { path: 'a.ts', approved: true },
          { path: 'a.ts', approved: false },
        ],
      },
      b: { files: [{ path: 'a.ts', approved: true }] },
    });
    const dupLeafCov = computeCoverage(planWithLeaf, dupLeafFields);
    expect(dupLeafCov.failedAtRuntime).toBe(2);
    expect(dupLeafCov.compared).toBe(0);
    expect(dupLeafCov.byReason['duplicate-key']).toBe(2);
  });

  it('3.10b keyed-set comparator treats present non-null non-array value as distinct presented split (I1)', () => {
    const schema = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'approved'],
            properties: {
              path: { type: 'string' },
              approved: { type: 'boolean' },
            },
          },
        },
        emptyFiles: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'approved'],
            properties: {
              path: { type: 'string' },
              approved: { type: 'boolean' },
            },
          },
        },
      },
    };
    const plan = buildPlanFields(schema, {
      files: { key: 'path' },
      emptyFiles: { key: 'path' },
    });
    const fields = compareFields(plan, {
      w1: {
        files: [{ path: 'a.ts', approved: true }],
        emptyFiles: [],
      },
      w2: {
        files: [{ path: 'a.ts', approved: true }],
        emptyFiles: [],
      },
      w3: {
        files: 'oops',
        emptyFiles: 'oops',
      },
    });

    expect(fields['/files']).toEqual({
      comparator: 'keyed-set',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2', 'w3'],
      missing: [],
      nulls: [],
      key: 'path',
      keys: {
        union: ['a.ts'],
        intersection: [],
        items: [{ item: 'a.ts', witnesses: ['w1', 'w2'], support: 2 }],
        jaccard: 0,
      },
      items: [
        {
          key: 'a.ts',
          witnesses: ['w1', 'w2'],
          fields: {
            '/approved': {
              comparator: 'exact',
              status: 'agree',
              answered: 2,
              presented: ['w1', 'w2'],
              missing: [],
              nulls: [],
              groups: [{ value: true, witnesses: ['w1', 'w2'], support: 2 }],
            },
          },
        },
      ],
    });

    expect(fields['/emptyFiles']).toEqual({
      comparator: 'keyed-set',
      status: 'split',
      answered: 3,
      presented: ['w1', 'w2', 'w3'],
      missing: [],
      nulls: [],
      key: 'path',
      keys: {
        union: [],
        intersection: [],
        items: [],
        jaccard: 0,
      },
      items: [],
    });

    const cov = computeCoverage(plan, fields);
    expect(cov.failedAtRuntime).toBe(0);
    expect(cov.compared).toBe(4);

    const findings = collectComparisonFindings({
      answered: 3,
      planFields: plan,
      fieldResults: fields,
      coverage: cov,
    });
    expect(findings).toEqual([
      {
        code: 'field-split',
        severity: 'warn',
        path: '/emptyFiles',
        witnesses: ['w1', 'w2', 'w3'],
      },
      {
        code: 'field-split',
        severity: 'warn',
        path: '/files',
        witnesses: ['w1', 'w2', 'w3'],
      },
    ]);
  });

  it('3.11 discriminated-union comparator: agree, choice split (critical), and branch leaf split with within/subpath', () => {
    const schema = {
      type: 'object',
      properties: {
        action: {
          oneOf: [
            {
              type: 'object',
              required: ['kind', 'target'],
              properties: {
                kind: { const: 'delete' },
                target: { enum: ['file', 'dir'] },
              },
            },
            {
              type: 'object',
              required: ['kind', 'count'],
              properties: {
                kind: { const: 'retry' },
                count: { type: 'integer' },
              },
            },
          ],
        },
      },
    };
    const plan = buildPlanFields(schema);

    // Agree
    const agree = compareFields(plan, {
      a: { action: { kind: 'delete', target: 'file' } },
      b: { action: { kind: 'delete', target: 'file' } },
    });
    expect(agree['/action']?.status).toBe('agree');

    // Choice split -> critical
    const choiceSplit = compareFields(plan, {
      a: { action: { kind: 'delete', target: 'file' } },
      b: { action: { kind: 'retry', count: 2 } },
    });
    expect(choiceSplit['/action']?.status).toBe('split');
    const choiceFindings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: choiceSplit,
      coverage: computeCoverage(plan, choiceSplit),
    });
    expect(choiceFindings).toContainEqual({
      code: 'field-split',
      severity: 'critical',
      path: '/action',
      witnesses: ['a', 'b'],
    });

    // Same branch, different leaf -> nested field-split with within and subpath
    const leafSplit = compareFields(plan, {
      a: { action: { kind: 'delete', target: 'file' } },
      b: { action: { kind: 'delete', target: 'dir' } },
    });
    expect(leafSplit['/action']?.status).toBe('split');
    const leafFindings = collectComparisonFindings({
      answered: 2,
      planFields: plan,
      fieldResults: leafSplit,
      coverage: computeCoverage(plan, leafSplit),
    });
    expect(leafFindings).toContainEqual({
      code: 'field-split',
      severity: 'critical',
      path: '/action',
      within: { branch: 'delete' },
      subpath: '/target',
      witnesses: ['a', 'b'],
    });
  });

  it('3.12 insufficient presenter count gives status insufficient and emits no field-split (D13)', () => {
    const schema = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
    };
    const plan = buildPlanFields(schema);
    const fields = compareFields(plan, {
      a: { ok: true },
      b: {},
      c: {},
    });
    expect(fields['/ok']?.status).toBe('insufficient');
    const findings = collectComparisonFindings({
      answered: 3,
      planFields: plan,
      fieldResults: fields,
      coverage: computeCoverage(plan, fields),
    });
    expect(findings.some(f => f.code === 'field-split')).toBe(false);
    expect(findings).toContainEqual({
      code: 'field-partial',
      severity: 'warn',
      path: '/ok',
      witnesses: ['b', 'c'],
    });
  });

  it('3.18 prototype-pollution keys (__proto__, constructor, prototype) compare safely (§12.2)', () => {
    const protoSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"boolean"},"constructor":{"type":"integer"},"prototype":{"type":"string"}}}',
    ) as unknown;
    const plan = buildPlanFields(protoSchema);
    const out1 = JSON.parse(
      '{"__proto__":true,"constructor":1,"prototype":"ok"}',
    ) as JSONValue;
    const out2 = JSON.parse(
      '{"__proto__":false,"constructor":1,"prototype":"ok"}',
    ) as JSONValue;

    const fields = compareFields(plan, { a: out1, b: out2 });
    expect(Object.getPrototypeOf(fields)).toBeNull();
    expect(
      Object.getOwnPropertyDescriptor(fields, '/__proto__')?.value,
    ).toMatchObject({
      comparator: 'exact',
      status: 'split',
    });
    expect(
      Object.getOwnPropertyDescriptor(fields, '/constructor')?.value,
    ).toMatchObject({
      comparator: 'exact',
      status: 'agree',
    });
    // Ensure global Object.prototype was not mutated
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, '/__proto__')).toBe(false);
  });
});
