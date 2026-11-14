import { describe, expectTypeOf, test } from 'vitest';
import { z } from 'zod';

import { corroborate } from './index.js';

import type { MockLanguageModelV4 } from 'ai/test';
import type { CorroborateOptions, Ledger, WitnessRecord } from './index.js';

const TestSchema = z.object({
  approved: z.boolean(),
  severity: z.enum(['low', 'high']),
  rationale: z.string(),
});

type TestOutput = z.infer<typeof TestSchema>;

describe('corroborate type tests (4.24)', () => {
  test('witness labels, output type, compare keys, and prompt/messages mutual exclusion', () => {
    type L = Ledger<TestOutput, 'gpt' | 'claude'>;

    expectTypeOf<L['witnesses']['gpt']>().toEqualTypeOf<
      WitnessRecord<TestOutput>
    >();

    // @ts-expect-error -- 'nope' is not a witness label in W
    type _BadWitness = L['witnesses']['nope'];

    type AnsweredOut = Extract<
      WitnessRecord<TestOutput>,
      { status: 'answered' }
    >['output'];
    expectTypeOf<AnsweredOut>().toEqualTypeOf<TestOutput>();

    type Opts = CorroborateOptions<TestOutput, 'gpt' | 'claude'>;
    const m = {} as MockLanguageModelV4;

    const validOpts: Opts = {
      witnesses: { gpt: m, claude: m },
      schema: TestSchema,
      prompt: 'Check this',
      compare: {
        approved: 'exact',
        '/severity': { comparator: 'exact', onSplit: 'warn' },
      },
    };
    expectTypeOf(validOpts).toMatchTypeOf<Opts>();

    const badCompare: Opts = {
      witnesses: { gpt: m, claude: m },
      schema: TestSchema,
      prompt: 'Check this',
      compare: {
        // @ts-expect-error -- unknownField is not a schema key or /pointer
        unknownField: 'exact',
      },
    };
    expectTypeOf(badCompare).toMatchTypeOf<Opts>();

    // @ts-expect-error -- prompt and messages are mutually exclusive
    const bothPromptAndMessages: Opts = {
      witnesses: { gpt: m, claude: m },
      schema: TestSchema,
      prompt: 'Hello',
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    expectTypeOf(bothPromptAndMessages).toMatchTypeOf<Opts>();

    const run = (): Promise<L> => corroborate(validOpts);
    expectTypeOf(run).returns.resolves.toEqualTypeOf<L>();
  });
});
