/**
 * End-to-end API change review example using three free-tier AI Gateway models,
 * deterministic adjudication, and Markdown + ASCII ledger rendering.
 *
 * Usage (requires AI_GATEWAY_API_KEY in .env.local or environment):
 *   node --env-file=.env.local node_modules/unrun/dist/cli.mjs examples/api-change-review.ts
 * (Or with Node 24+ native TS stripping:
 *   node --env-file=.env.local examples/api-change-review.ts)
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { adjudicate, corroborate, formatLedger } from '../src/index.js';
import type { Evidence } from '../src/index.js';

const ApiChangeReviewSchema = z.object({
  changesPublicApi: z.boolean(),
  affectedExports: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  confidence: z.number(),
  reasoning: z.string(),
});

const SAMPLE_DIFF = `diff --git a/src/client.ts b/src/client.ts
index 4b825dc..9e1c2a1 100644
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,14 +1,14 @@
 export interface ReviewOptions {
   model: string;
-  /** @deprecated Use instructions instead. */
-  system?: string;
+  instructions?: string;
   maxTokens?: number;
 }

 export interface ReviewResult {
   summary: string;
   approved: boolean;
+  /** Breaking: changed from number (0..1) to string grade. */
+  score: 'low' | 'medium' | 'high';
 }

-export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
+export async function executeReview(options: ReviewOptions): Promise<ReviewResult> {
   return { summary: options.model, approved: true, score: 'high' };
 }`;

function runTypecheckEvidence(): Evidence {
  try {
    execFileSync(
      process.execPath,
      ['./node_modules/typescript/bin/tsc', '--noEmit'],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return {
      source: 'tsc --noEmit',
      outcome: 'pass',
      claim: { scope: 'artifact' },
      details: { exitCode: 0 },
    };
  } catch (error: unknown) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status ?? 1)
        : 1;
    return {
      source: 'tsc --noEmit',
      outcome: 'fail',
      claim: { scope: 'artifact' },
      details: { exitCode: status },
    };
  }
}

function runPublicExportDiffEvidence(diff: string): Evidence {
  const removesExport = diff
    .split(/\r?\n/)
    .some(line =>
      /^-\s*export\s+(?:async\s+)?(?:function|const|class|type|interface)\b/.test(
        line,
      ),
    );
  return {
    source: 'diff-export-check',
    outcome: 'pass',
    claim: { path: 'changesPublicApi', value: removesExport },
    details: { removesOrRenamesExport: removesExport },
  };
}

async function main(): Promise<void> {
  const ledger = await corroborate({
    witnesses: {
      openai: 'openai/gpt-4o-mini',
      google: 'google/gemini-2.5-flash',
      zai: 'zai/glm-4.7-flash',
    },
    schema: ApiChangeReviewSchema,
    schemaName: 'ApiChangeReview',
    schemaDescription:
      'Structured public-API impact assessment for a TypeScript diff.',
    instructions:
      'Review the unified TypeScript diff strictly for public API surface changes and migration risk.',
    prompt: `Analyze this TypeScript diff and return JSON matching the schema:\n\n${SAMPLE_DIFF}`,
    compare: {
      changesPublicApi: { onSplit: 'critical' },
      affectedExports: 'set',
      confidence: { tolerance: { absolute: 0.05 }, onSplit: 'info' },
    },
  });

  const evidence: Evidence[] = [
    runTypecheckEvidence(),
    runPublicExportDiffEvidence(SAMPLE_DIFF),
  ];

  const adjudication = await adjudicate(ledger, evidence, {
    escalateOnReview: true,
  });

  console.log('=== MARKDOWN ===');
  console.log(formatLedger(ledger, { adjudication, format: 'markdown' }));
  console.log('\n=== ASCII ===');
  console.log(formatLedger(ledger, { adjudication, format: 'ascii' }));
}

// No top-level await: tsx/unrun CJS compatibility.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
