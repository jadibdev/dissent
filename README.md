# Dissent

**Ask several AI models the same question, and see where they disagree before you ship.**

One model gives you one confident answer. Dissent asks several models independently through the [Vercel AI SDK](https://ai-sdk.dev) using structured output, compares their answers with deterministic code field by field, records witness failures and provenance signals, optionally reconciles deterministic tool checks via `adjudicate()`, and formats an escaped report for humans and CI.

Dissent **compares** and **records**. It does not verify truth, summarize opinions with another model, or vote a winner.

> Tested live against `openai/gpt-4o-mini`, `google/gemini-2.5-flash`, and `zai/glm-4.7-flash` via the Vercel AI Gateway; works with any AI SDK `LanguageModel`.

## Principles

- **Models are witnesses, never judges.** Model outputs are claims to compare, not verdicts. No model gets the final word, and there is no majority-vote override.
- **The comparison is code, not another model.** Identical inputs and outputs produce the same `fingerprint` and `Ledger`.
- **Only artifact evidence decides.** A `confirmed` or `rejected` verdict appears only when you supply deterministic artifact-level evidence (tests, typechecks, linters). Without it, Dissent returns `uncertain` plus an `advisory`, and a human decides.
- **Failures are recorded, never hidden.** If a witness times out, refuses, hits an API error, or returns non-JSON / truncated output, the failure is recorded under a 7-kind taxonomy (`invalid-output`, `truncated`, `refused`, `api-error`, `timeout`, `aborted`, `unknown`). Nothing is backfilled or retried silently.

## How Dissent Differs from `llm-council` / LLM-as-a-Judge

- **No judge LLM:** Dissent never sends witness answers to another model to rank, synthesize, or break ties.
- **Schema-aware comparison:** Booleans, enums, numbers (with tolerance), sets, keyed object arrays, and discriminated unions are compared deterministically at field resolution rather than collapsing answers into prose or a single scalar score.
- **Evidence-only verdicts:** Witness splits settle only when matched against deterministic field-bound evidence (`claim: { path, value }`), and overall outcomes (`confirmed` / `rejected`) depend strictly on artifact-level checks (`claim: { scope: 'artifact' }`).
- **Provenance and independence checks:** Flags shared providers (`single-provider`), duplicate served model IDs (`duplicate-served-model`), and author-model self-grading (`self-grading` / `excludeAuthor`).

## Install

Dissent targets Node `>=22` (and pure comparison/adjudication/rendering modules have zero Node built-ins or `ai` runtime imports for edge runtimes). `ai` (`^7.0.162`) is a peer dependency.

```bash
pnpm add dissent ai zod
```

## Quick Start

See [`examples/api-change-review.ts`](./examples/api-change-review.ts) for a complete runnable script using free-tier AI Gateway models, `tsc --noEmit` artifact evidence, and a deterministic diff-export check:

```ts
import { adjudicate, corroborate, formatLedger } from 'dissent';
import { z } from 'zod';

const ReviewSchema = z.object({
  changesPublicApi: z.boolean(),
  affectedExports: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  confidence: z.number(),
  reasoning: z.string(),
});

const ledger = await corroborate({
  witnesses: {
    openai: 'openai/gpt-4o-mini',
    google: 'google/gemini-2.5-flash',
    zai: 'zai/glm-4.7-flash',
  },
  schema: ReviewSchema,
  schemaName: 'ApiChangeReview',
  instructions: 'Review the TypeScript diff for public API changes.',
  prompt: diffText,
  compare: {
    changesPublicApi: { onSplit: 'critical' },
    affectedExports: 'set',
    confidence: { tolerance: { absolute: 0.05 }, onSplit: 'info' },
  },
});

const adjudication = await adjudicate(ledger, [
  {
    source: 'tsc --noEmit',
    outcome: 'pass',
    claim: { scope: 'artifact' },
  },
  {
    source: 'diff-export-check',
    outcome: 'pass',
    claim: { path: 'changesPublicApi', value: true },
  },
]);

console.log(formatLedger(ledger, { adjudication, format: 'markdown' }));
```

## Schema Design Advice

Dissent derives a deterministic `FieldPlan` from your JSON Schema before calling any model:

- **Use booleans and enums for what matters.** `boolean`, `enum`, `const`, and `integer` default to `exact` comparison. These are the cleanest signals for catching real disagreement.
- **Use enum items for arrays you want compared.** If an array holds a known finite vocabulary (e.g. `z.array(z.enum(['auth', 'billing', 'api']))`), witnesses pick from the same tokens and `'set'` comparison works reliably. **Free-text `z.array(z.string())` items almost always split** because different models phrase string elements differently (`"login flow"` vs `"authentication"`).
- **Keep free text (`z.string()`) for reasoning and summaries.** Unconstrained strings and numbers without a tolerance default to `'none'` (`not-compared`) by policy. Their answers are still preserved per witness and shown side by side in rendered output without triggering false splits.
- **Specify tolerances on floats.** `z.number()` defaults to `'none'` (`number-without-tolerance`). Pass `compare: { confidence: { tolerance: { absolute: 0.05 } } }` (or `{ relative: ... }`) to group numbers with single-linkage clustering.
- **Override comparators when structure needs help.** Supported overrides in `compare`: `'exact'`, `'set'`, `'none'`, `{ tolerance: { absolute?, relative? }, onSplit? }`, `{ key: 'id', onSplit? }` (for arrays of objects matched by unique key), and `{ onSplit: 'info' | 'warn' | 'critical' }`.

## Coverage, Findings, and Advisory

- **`coverage`:** Tracks every leaf and composite entry in the comparison plan:
  - `compared`: fields actively compared (`exact`, `tolerance`, `set`, `keyed-set`, `discriminated-union`).
  - `notComparedByPolicy`: fields intentionally skipped (`free-text`, `number-without-tolerance`, `caller-none`). These do **not** lower `coverage.ratio`.
  - `unsupported` / `failedAtRuntime`: schema constructs Dissent does not compare (for example object arrays without `{ key }`, untyped schemas, external `$ref`s) or runtime key collisions (`duplicate-key`). These **do** lower `coverage.ratio = compared / (fields - notComparedByPolicy)`.
- **`findings` and `advisory`:** Deterministic rollup of quorum, witness failures/exclusions, field splits (`info` | `warn` | `critical`), duplicate keys, coverage drops, and independence checks (`single-provider`, `duplicate-served-model`, `self-grading`).
  - Any `critical` finding produces `advisory: 'review-required'`.
  - Any `warn` finding produces `advisory: 'warnings'`.
  - Otherwise `advisory: 'clear'`.

## Adjudication and Evidence

`adjudicate(ledger, evidence, options?)` keeps witness comparison and tool truth strictly separate:

1. **Field-bound settlements (`claim: { path, value }`):** Checks whether deterministic evidence agrees with each answering witness on a compared field (`witnessesAgreeing`, `witnessesDissenting`, `witnessesSilent`). Field-bound evidence **never** sets the overall verdict.
2. **Artifact verdict (`claim: { scope: 'artifact' }`):** Drives `verdict` and `verdictReason`:
   - Zero artifact evidence → `uncertain` (`no-artifact-evidence`)
   - Any artifact `fail` → `rejected` (`artifact-evidence-failed`)
   - Any artifact `error` or `unknown` without a `fail` → `uncertain` (`artifact-evidence-inconclusive`)
   - All artifact checks `pass` (and `escalateOnReview` not triggered) → `confirmed` (`artifact-evidence-passed`)
   - All artifact checks `pass` + `escalateOnReview: true` + `ledger.advisory === 'review-required'` → `uncertain` (`escalated-on-review`)
3. **Unbound evidence:** Evidence without a `claim`, targeting an unknown path, or targeting a path inside a keyed array item is recorded in `unbound` without moving `verdict`.

> **Experimental APIs:** `Evidence.claims`, `Evidence.receipt`, `validateOfflineReceipt()`, and `AdjudicateOptions.requireOfflineReceipt` are marked `@experimental` and may change in a minor release before an external sandbox receipt producer is added.

## Rendering (`formatLedger`)

`formatLedger(ledger, options?)` formats ledgers and optional `Adjudication` results in two layouts:

- `'markdown'` (default): GitHub-flavored Markdown with headers, witness status table, independence summary, field results, coverage, findings, adjudication verdict/settlements, and dynamic-fence untrusted blocks.
- `'ascii'`: 78-column plain-ASCII layout suitable for terminals and CI logs, free of ANSI/OSC escape sequences and BiDi control characters.

All untrusted strings (model outputs, error messages, evidence sources, model IDs) are sanitized and escaped before emission.

## Privacy and Cost Notes

- **Privacy:** Your `instructions`, `prompt` / `messages`, and `schema` are sent to **every** non-excluded model configured in `witnesses` (each witness provider receives the full request). By default (`includeInput: 'hash'`), the returned `Ledger` records only SHA-256 hashes of inputs rather than the prompt text; pass `includeInput: 'full'` only when storing raw inputs in ledgers is acceptable. Error messages captured from SDK errors are stripped of control characters and redacted for common bearer/key/credential tokens before storage.
- **Cost and Latency:** Corroborating across `N` witnesses makes `N` independent `generateText` requests, consuming roughly `N×` input/output tokens and billing across the providers you configure. Requests run concurrently up to `maxConcurrency` (default `8`), and token totals are aggregated in `ledger.usage`.

## Running the Example

Run the end-to-end API change review example locally with a Vercel AI Gateway key (`AI_GATEWAY_API_KEY`):

```bash
AI_GATEWAY_API_KEY=... pnpm exec unrun examples/api-change-review.ts
```

Or load the key from a local env file:

```bash
node --env-file=.env.local node_modules/unrun/dist/cli.mjs examples/api-change-review.ts
```

## License

[Apache-2.0](./LICENSE)
