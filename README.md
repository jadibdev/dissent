# Dissent

**Ask several AI models the same question, and see where they disagree before you ship.**

One model gives you one confident answer. Dissent asks several models, through the [Vercel AI SDK](https://ai-sdk.dev), to answer the same question independently and in the same structured format. Then it compares their answers with plain, deterministic code: where they agree, where they disagree, and what still needs a human.

Disagreement isn't noise. It's where the useful information is.

## Principles

- **Models are witnesses, never judges.** Their answers are opinions. No model gets the final word, and neither does a majority vote.
- **The comparison is code, not another model.** The same answers always produce the same record.
- **Only evidence decides.** A verdict appears only when you supply hard evidence, such as test or tool results. Otherwise you get an advisory, and you decide.
- **Failures are recorded, never hidden.** If a model errors or times out, the record says so. Nothing is filled in.

## Status

Pre-release. The first API, `corroborate()`, is in development and isn't published yet. Follow along or open an issue with your use case.

## License

[Apache-2.0](./LICENSE)
