import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DissentArgumentError } from '../errors.js';
import { buildPlanFields } from './derive-plan.js';
import { walkSchema } from './walk-schema.js';

describe('schema walker and default comparison table', () => {
  it('3.1 derives default comparators and severities row by row from Zod 4 schemas (I14)', () => {
    const schema = asSchema(
      z.object({
        flag: z.boolean(),
        level: z.enum(['low', 'high']),
        version: z.literal('v1'),
        count: z.number().int(),
        score: z.number(),
        summary: z.string(),
        tags: z.array(z.string()),
        weights: z.array(z.number()),
        findings: z.array(z.object({ id: z.string(), ok: z.boolean() })),
        meta: z.object({
          owner: z.string(),
          approved: z.boolean(),
        }),
      }),
    ).jsonSchema;

    const fields = buildPlanFields(schema);

    expect(fields['/flag']).toMatchObject({
      comparator: 'exact',
      onSplit: 'critical',
      reasons: ['default-by-type'],
    });
    expect(fields['/level']).toMatchObject({
      comparator: 'exact',
      onSplit: 'critical',
      reasons: ['default-by-type'],
    });
    expect(fields['/version']).toMatchObject({
      comparator: 'exact',
      onSplit: 'critical',
      reasons: ['default-by-type'],
    });
    expect(fields['/count']).toMatchObject({
      comparator: 'exact',
      onSplit: 'warn',
      reasons: ['default-by-type'],
    });
    expect(fields['/score']).toMatchObject({
      comparator: 'none',
      reason: 'policy',
      detail: 'number-without-tolerance',
    });
    expect(fields['/summary']).toMatchObject({
      comparator: 'none',
      reason: 'policy',
      detail: 'free-text',
    });
    expect(fields['/tags']).toMatchObject({
      comparator: 'set',
      onSplit: 'warn',
      reasons: ['default-by-type'],
    });
    expect(fields['/weights']).toMatchObject({
      comparator: 'none',
      reason: 'policy',
      detail: 'number-array',
    });
    expect(fields['/findings']).toMatchObject({
      comparator: 'none',
      reason: 'unsupported',
      detail: 'object-array-requires-key',
    });
    expect(fields['/meta']).toBeUndefined();
    expect(fields['/meta/owner']).toMatchObject({
      comparator: 'none',
      reason: 'policy',
      detail: 'free-text',
    });
    expect(fields['/meta/approved']).toMatchObject({
      comparator: 'exact',
      onSplit: 'critical',
    });
  });

  it('3.1 rejects non-object root schemas with schema-root-not-object (I14)', () => {
    for (const bad of [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object' },
      null,
      'string',
    ]) {
      expect(() => walkSchema(bad)).toThrowError(DissentArgumentError);
      try {
        walkSchema(bad);
      } catch (e) {
        expect(DissentArgumentError.isInstance(e)).toBe(true);
        if (DissentArgumentError.isInstance(e)) {
          expect(e.code).toBe('schema-root-not-object');
        }
      }
    }
  });

  it('3.2 unwraps nullable in type array, 2-branch anyOf, and 2-branch oneOf with ordered reasons', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: ['boolean', 'null'] },
        b: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        c: { oneOf: [{ type: 'null' }, { type: 'string' }] },
      },
    };

    const fields = buildPlanFields(schema);
    expect(fields['/a']).toEqual({
      comparator: 'exact',
      onSplit: 'critical',
      nullable: true,
      reasons: ['nullable-unwrap', 'default-by-type'],
    });
    expect(fields['/b']).toEqual({
      comparator: 'exact',
      onSplit: 'warn',
      nullable: true,
      reasons: ['nullable-unwrap', 'default-by-type'],
    });
    expect(fields['/c']).toEqual({
      comparator: 'none',
      reason: 'policy',
      detail: 'free-text',
      nullable: true,
      reasons: ['nullable-unwrap', 'policy'],
    });
  });

  it('3.3 resolves local $ref and rejects external, cyclic, deep, and dangling refs as unsupported (I14)', () => {
    // 17-level deep chain exceeding MAX_SCHEMA_DEPTH = 16
    let deep: Record<string, unknown> = { type: 'boolean' };
    for (let i = 0; i < 18; i++) {
      deep = { type: 'object', properties: { child: deep } };
    }

    const schema = {
      $defs: {
        Risk: {
          type: 'object',
          properties: {
            severity: { enum: ['low', 'high'] },
          },
        },
        Node: {
          type: 'object',
          properties: {
            next: { $ref: '#/$defs/Node' },
          },
        },
      },
      type: 'object',
      properties: {
        risk: { $ref: '#/$defs/Risk' },
        ext: { $ref: 'https://example.com/schema.json' },
        cycle: { $ref: '#/$defs/Node' },
        missingRef: { $ref: '#/$defs/DoesNotExist' },
        deep,
      },
    };

    const fields = buildPlanFields(schema);
    expect(fields['/risk/severity']).toEqual({
      comparator: 'exact',
      onSplit: 'critical',
      nullable: false,
      reasons: ['ref-resolved', 'default-by-type'],
    });
    expect(fields['/ext']).toMatchObject({
      comparator: 'none',
      reason: 'unsupported',
      detail: 'external-ref',
    });
    expect(fields['/cycle/next']).toMatchObject({
      comparator: 'none',
      reason: 'unsupported',
      detail: 'ref-cycle',
    });
    expect(fields['/missingRef']).toMatchObject({
      comparator: 'none',
      reason: 'unsupported',
      detail: 'invalid-ref',
    });

    const deepKeys = Object.keys(fields).filter(k => k.startsWith('/deep'));
    expect(deepKeys.length).toBe(1);
    expect(fields[deepKeys[0]!]).toMatchObject({
      comparator: 'none',
      reason: 'unsupported',
      detail: 'depth-exceeded',
    });
  });

  it('3.4 detects discriminated unions (const/enum, nullable 3-branch) and rejects non-discriminated unions (I14)', () => {
    const schema = {
      type: 'object',
      properties: {
        byConst: {
          oneOf: [
            {
              type: 'object',
              required: ['kind', 'a'],
              properties: {
                kind: { const: 'alpha' },
                a: { type: 'integer' },
              },
            },
            {
              type: 'object',
              required: ['kind', 'b'],
              properties: {
                kind: { type: 'string', const: 'beta' },
                b: { type: 'boolean' },
              },
            },
          ],
        },
        byEnumNullable: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              required: ['type', 'x'],
              properties: {
                type: { enum: ['one'] },
                x: { type: 'integer' },
              },
            },
            {
              type: 'object',
              required: ['type', 'y'],
              properties: {
                type: { enum: ['two'] },
                y: { type: 'string' },
              },
            },
          ],
        },
        noCommonLiteral: {
          anyOf: [
            {
              type: 'object',
              required: ['a'],
              properties: { a: { type: 'string' } },
            },
            {
              type: 'object',
              required: ['b'],
              properties: { b: { type: 'integer' } },
            },
          ],
        },
        dupDiscValue: {
          oneOf: [
            {
              type: 'object',
              required: ['k', 'x'],
              properties: { k: { const: 'same' }, x: { type: 'integer' } },
            },
            {
              type: 'object',
              required: ['k', 'y'],
              properties: { k: { enum: ['same'] }, y: { type: 'boolean' } },
            },
          ],
        },
        nonObjectBranch: {
          anyOf: [
            {
              type: 'object',
              required: ['k'],
              properties: { k: { const: 'obj' } },
            },
            { type: 'string' },
          ],
        },
        threeNonDisc: {
          anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
        },
      },
    };

    const fields = buildPlanFields(schema);
    expect(fields['/byConst']).toMatchObject({
      comparator: 'discriminated-union',
      discriminator: 'kind',
      nullable: false,
      onSplit: 'critical',
    });
    if (fields['/byConst']?.comparator === 'discriminated-union') {
      expect(Object.keys(fields['/byConst'].branches)).toEqual([
        '"alpha"',
        '"beta"',
      ]);
      expect(fields['/byConst'].branches['"alpha"']?.['/kind']).toBeUndefined();
      expect(fields['/byConst'].branches['"alpha"']?.['/a']).toMatchObject({
        comparator: 'exact',
      });
    }

    expect(fields['/byEnumNullable']).toMatchObject({
      comparator: 'discriminated-union',
      discriminator: 'type',
      nullable: true,
      reasons: ['nullable-unwrap', 'discriminated-union'],
    });

    for (const key of [
      '/noCommonLiteral',
      '/dupDiscValue',
      '/nonObjectBranch',
      '/threeNonDisc',
    ]) {
      expect(fields[key]).toMatchObject({
        comparator: 'none',
        reason: 'unsupported',
        detail: 'union',
      });
    }
  });
});
