import { describe, expect, it } from 'vitest';

import { DissentArgumentError } from '../errors.js';
import type { ComparatorOverride } from '../types.js';
import { buildPlanFields, derivePlan } from './derive-plan.js';

function expectArgumentCode(fn: () => unknown, expectedCode: string): void {
  expect(fn).toThrowError(DissentArgumentError);
  try {
    fn();
  } catch (err) {
    expect(DissentArgumentError.isInstance(err)).toBe(true);
    if (DissentArgumentError.isInstance(err)) {
      expect(err.code).toBe(expectedCode);
    }
  }
}

const baseSchema = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    flag: { type: 'boolean' },
    score: { type: 'number' },
    count: { type: 'integer' },
    nums: { type: 'array', items: { type: 'number' } },
    tags: { type: 'array', items: { type: 'string' } },
    tupleField: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
    },
    meta: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        active: { type: 'boolean' },
      },
    },
    extra: { type: 'object' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'ok'],
        properties: {
          id: { type: 'string' },
          ok: { type: 'boolean' },
          optionalTag: { type: 'string' },
          badKeyNum: { type: 'number' },
          nullableKey: { type: ['string', 'null'] },
          nestedUnion: {
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'x'],
                properties: { kind: { const: 'a' }, x: { type: 'integer' } },
              },
              {
                type: 'object',
                required: ['kind', 'y'],
                properties: { kind: { const: 'b' }, y: { type: 'boolean' } },
              },
            ],
          },
        },
      },
    },
  },
};

describe('derivePlan overrides and validation (§5.5)', () => {
  it('3.6 applies all valid caller overrides and produces stable fingerprints (I3, §5.5)', async () => {
    const plan = await derivePlan(baseSchema, {
      note: 'exact',
      '/meta': 'exact',
      extra: { comparator: 'exact', onSplit: 'critical' },
      nums: 'set',
      tupleField: 'set',
      score: { tolerance: { absolute: 0.05, relative: 0.01 } },
      count: { tolerance: { relative: 0.1 }, onSplit: 'info' },
      items: { key: 'id' },
      flag: 'none',
      '/tags': { onSplit: 'critical' },
    });

    expect(plan.fields['/note']).toEqual({
      comparator: 'exact',
      onSplit: 'warn',
      nullable: false,
      reasons: ['caller-override'],
    });
    // Object override stops recursion and removes children
    expect(plan.fields['/meta']).toEqual({
      comparator: 'exact',
      onSplit: 'warn',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/meta/owner']).toBeUndefined();
    expect(plan.fields['/meta/active']).toBeUndefined();

    expect(plan.fields['/extra']).toEqual({
      comparator: 'exact',
      onSplit: 'critical',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/nums']).toEqual({
      comparator: 'set',
      onSplit: 'warn',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/tupleField']).toEqual({
      comparator: 'set',
      onSplit: 'warn',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/score']).toEqual({
      comparator: 'tolerance',
      tolerance: { absolute: 0.05, relative: 0.01 },
      onSplit: 'warn',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/count']).toEqual({
      comparator: 'tolerance',
      tolerance: { relative: 0.1 },
      onSplit: 'info',
      nullable: false,
      reasons: ['caller-override'],
    });
    expect(plan.fields['/flag']).toEqual({
      comparator: 'none',
      reason: 'policy',
      detail: 'caller-none',
      nullable: false,
      reasons: ['caller-override', 'policy'],
    });
    expect(plan.fields['/tags']).toEqual({
      comparator: 'set',
      onSplit: 'critical',
      nullable: false,
      reasons: ['default-by-type', 'caller-override'],
    });

    const itemsPlan = plan.fields['/items'];
    expect(itemsPlan?.comparator).toBe('keyed-set');
    if (itemsPlan?.comparator === 'keyed-set') {
      expect(itemsPlan.key).toBe('id');
      expect(itemsPlan.itemFields['/id']).toBeUndefined();
      expect(itemsPlan.itemFields['/ok']).toMatchObject({
        comparator: 'exact',
        onSplit: 'critical',
      });
      expect(itemsPlan.itemFields['/optionalTag']).toMatchObject({
        comparator: 'none',
        reason: 'policy',
        detail: 'free-text',
      });
      // Nested discriminated union inside keyed-set item degrades to nested-composite (D9)
      expect(itemsPlan.itemFields['/nestedUnion']).toMatchObject({
        comparator: 'none',
        reason: 'unsupported',
        detail: 'nested-composite',
      });
    }

    const plan2 = await derivePlan(baseSchema, {
      '/tags': { onSplit: 'critical' },
      note: 'exact',
      '/meta': 'exact',
      extra: { comparator: 'exact', onSplit: 'critical' },
      nums: 'set',
      tupleField: 'set',
      score: { tolerance: { relative: 0.01, absolute: 0.05 } },
      count: { tolerance: { relative: 0.1 }, onSplit: 'info' },
      items: { key: 'id' },
      flag: 'none',
    });
    expect(plan2.fingerprint).toBe(plan.fingerprint);
  });

  it('3.6 rejects all invalid overrides with exact DissentArgumentError codes (§5.5)', () => {
    // Unknown path & path inside keyed-set item
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { '/nope': 'exact' }),
      'unknown-compare-path',
    );
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, {
          items: { key: 'id' },
          '/items/ok': 'exact',
        }),
      'unknown-compare-path',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { '/items/[]/ok': 'exact' }),
      'unknown-compare-path',
    );

    // `set` on non-array
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { note: 'set' }),
      'incompatible-override',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { flag: { comparator: 'set' } }),
      'incompatible-override',
    );

    // `tolerance` on non-number
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, { note: { tolerance: { absolute: 1 } } }),
      'incompatible-override',
    );

    // Invalid tolerance configurations
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, { score: { tolerance: { absolute: -1 } } }),
      'invalid-tolerance',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { score: { tolerance: {} } }),
      'invalid-tolerance',
    );
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, {
          score: { tolerance: { absolute: Number.NaN } },
        }),
      'invalid-tolerance',
    );
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, {
          score: { tolerance: { absolute: Number.POSITIVE_INFINITY } },
        }),
      'invalid-tolerance',
    );

    // Key validation on `{ key }`
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { note: { key: 'id' } }),
      'incompatible-override',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { tupleField: { key: 'id' } }),
      'incompatible-override',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { items: { key: 'missing' } }),
      'invalid-key',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { items: { key: 'optionalTag' } }),
      'invalid-key',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { items: { key: 'badKeyNum' } }),
      'invalid-key',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { items: { key: 'nullableKey' } }),
      'invalid-key',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { items: { key: '' } }),
      'invalid-key',
    );

    // `{ onSplit }` alone on default-none field or plain object
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { note: { onSplit: 'critical' } }),
      'incompatible-override',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { score: { onSplit: 'info' } }),
      'incompatible-override',
    );
    expectArgumentCode(
      () => buildPlanFields(baseSchema, { meta: { onSplit: 'info' } }),
      'incompatible-override',
    );
    expectArgumentCode(
      () =>
        buildPlanFields(baseSchema, {
          flag: {
            comparator: 'none',
            onSplit: 'warn',
          } as unknown as ComparatorOverride,
        }),
      'incompatible-override',
    );
  });
});
