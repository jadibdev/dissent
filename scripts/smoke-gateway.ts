/**
 * Manual Gateway smoke test (costs money; run by hand, never in CI).
 *
 * Usage (requires AI_GATEWAY_API_KEY in environment):
 *   pnpm dlx tsx scripts/smoke-gateway.ts
 */
import { z } from 'zod';

import { corroborate } from '../src/index.js';

const SmokeSchema = z.object({
  isBreakingChange: z.boolean(),
  severity: z.enum(['low', 'medium', 'high']),
  affectedAreas: z.array(z.string()),
  rollbackNote: z.string().nullable(),
  rationale: z.string(),
});

async function main(): Promise<void> {
  const ledger = await corroborate({
    witnesses: {
      openai: 'openai/gpt-4o-mini',
      zai: 'zai/glm-4.7-flash',
      google: 'google/gemini-2.5-flash',
    },
    schema: SmokeSchema,
    schemaName: 'ApiChangeAssessment',
    schemaDescription: 'Structured risk assessment of a proposed API change.',
    instructions:
      'Assess the proposed change concisely and return structured JSON matching the schema.',
    prompt: [
      'A library proposes renaming an exported function option from `system` to `instructions`',
      'in its next major release while removing the old option.',
      'Assess whether this is a breaking change, its severity, affected areas, any rollback note, and rationale.',
    ].join(' '),
  });

  console.log(JSON.stringify(ledger, null, 2));

  if (ledger.quorum.answered < 2) {
    process.exitCode = 1;
  }
}

// No top-level await: tsx may compile this file as CommonJS.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
