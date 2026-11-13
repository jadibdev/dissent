import { describe, expectTypeOf, it } from 'vitest';

import type {
  CompareOverrides,
  CorroborateOptions,
  FieldPlan,
  Finding,
  FindingCode,
  Ledger,
  WitnessRecord,
} from './index.js';

describe('public types', () => {
  it('Ledger is keyed by the witness label union', () => {
    expectTypeOf<Ledger<{ a: 1 }, 'x' | 'y'>['witnesses']>().toEqualTypeOf<
      Record<'x' | 'y', WitnessRecord<{ a: 1 }>>
    >();
  });

  it('WitnessRecord narrows on status', () => {
    const record = null as unknown as WitnessRecord<{ n: number }>;
    if (record.status === 'answered') {
      expectTypeOf(record.output).toEqualTypeOf<{ n: number }>();
    } else if (record.status === 'failed') {
      expectTypeOf(record.error.kind).toBeString();
    } else {
      expectTypeOf(record.stage).toEqualTypeOf<
        'before-dispatch' | 'after-response'
      >();
    }
  });

  it('exactOptionalPropertyTypes forbids explicit undefined (I8)', () => {
    // @ts-expect-error optional keys are absent, never undefined
    const finding: Finding = {
      code: 'field-split',
      severity: 'warn',
      path: undefined,
    };
    void finding;
  });

  it('closed sets reject unknown members', () => {
    expectTypeOf<'self-grading'>().toExtend<FindingCode>();
    expectTypeOf<'made-up'>().not.toExtend<FindingCode>();
    expectTypeOf<FieldPlan['comparator']>().toEqualTypeOf<
      | 'exact'
      | 'tolerance'
      | 'set'
      | 'keyed-set'
      | 'discriminated-union'
      | 'none'
    >();
  });

  it('CorroborateOptions forbids prompt together with messages', () => {
    type O = CorroborateOptions<{ a: string }, 'x' | 'y'>;
    const both = { prompt: 'p', messages: [] } as const;
    // @ts-expect-error prompt and messages are mutually exclusive
    const bad: Pick<O, 'prompt' | 'messages'> = both;
    void bad;
  });

  it('CompareOverrides accepts top-level keys and pointers only', () => {
    type C = CompareOverrides<{ risk: string; n: number }>;
    expectTypeOf<keyof C>().toEqualTypeOf<'risk' | 'n' | `/${string}`>();
  });
});
