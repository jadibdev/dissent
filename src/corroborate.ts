import { NoObjectGeneratedError, Output, asSchema, generateText } from 'ai';

import { canonicalJson } from './canonical/canonical-json.js';
import { hashForm } from './canonical/hash-input.js';
import { sha256Hex } from './canonical/sha256.js';
import {
  compareFields as defaultCompareFields,
  type AnsweredOutput,
} from './compare/compare-fields.js';
import { computeCoverage } from './compare/coverage.js';
import { derivePlan } from './compare/derive-plan.js';
import { isPlainObject, toSortedNullProtoRecord } from './compare/util.js';
import { DissentArgumentError } from './errors.js';
import {
  collectComparisonFindings,
  computeAdvisory,
  sortFindings,
} from './findings.js';
import {
  OutputTooLargeError,
  classifyWitnessError,
  mapUsage,
} from './witness/classify-error.js';
import {
  analyzeIndependence,
  matchAuthorModel,
} from './witness/independence.js';
import {
  normalizeAndValidateOptions,
  toServedIdentity,
  type NormalizedOptions,
  type NormalizedWitness,
} from './witness/normalize-witnesses.js';
import { sanitizeWarnings, utf8ByteLength } from './witness/redact.js';

import type {
  FinishReason,
  JSONSchema7,
  LanguageModelUsage,
  CallWarning,
} from 'ai';

import type {
  CorroborateOptions,
  JSONValue,
  Ledger,
  QuestionRecord,
  Quorum,
  WitnessError,
  WitnessRecord,
  WitnessUsage,
} from './types.js';

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

export type CorroborateInternalHooks = {
  compareFields?: typeof defaultCompareFields;
  onGenerateTextParams?: (params: Parameters<typeof generateText>[0]) => void;
};

type QuestionResult = {
  question: QuestionRecord;
};

async function buildQuestion<T, W extends string>(
  options: CorroborateOptions<T, W>,
  normalized: NormalizedOptions<W>,
  resolvedSchema: JSONSchema7,
): Promise<QuestionResult> {
  const normalize = normalized.lineEndings === 'normalize-for-hash';
  const lineEndingsRecord = normalize ? 'normalized-for-hash' : 'preserved';
  const inputKind = options.prompt !== undefined ? 'prompt' : 'messages';
  const rawInput = inputKind === 'prompt' ? options.prompt : options.messages;

  const hashedInput = await hashForm(rawInput, normalize, inputKind);
  const inputCanon = canonicalJson(hashedInput);
  const inputBytes = utf8ByteLength(inputCanon);
  const inputHash = await sha256Hex(inputCanon);

  const instructionsHash =
    options.instructions !== undefined
      ? await sha256Hex(
          canonicalJson(
            await hashForm(options.instructions, normalize, 'instructions'),
          ),
        )
      : null;

  const schemaObj: Record<string, JSONValue> = {
    jsonSchema: resolvedSchema as unknown as JSONValue,
  };
  if (options.schemaName !== undefined) {
    schemaObj.name = options.schemaName;
  }
  if (options.schemaDescription !== undefined) {
    schemaObj.description = options.schemaDescription;
  }
  const schemaHash = await sha256Hex(canonicalJson(schemaObj));

  const fingerprint = await sha256Hex(
    canonicalJson({
      protocol: 'dissent-question/1',
      inputKind,
      inputHash,
      instructionsHash,
      schemaHash,
      lineEndings: lineEndingsRecord,
    }),
  );

  const question: QuestionRecord = {
    fingerprint,
    inputKind,
    inputHash,
    instructionsHash,
    schemaHash,
    inputBytes,
    lineEndings: lineEndingsRecord,
  };

  if (normalized.includeInput === 'full') {
    const raw: NonNullable<QuestionRecord['raw']> = {};
    if (options.instructions !== undefined) {
      raw.instructions = await hashForm(
        options.instructions,
        false,
        'instructions',
      );
    }
    const rawPreserved = normalize
      ? await hashForm(rawInput, false, inputKind)
      : hashedInput;
    if (inputKind === 'prompt') {
      raw.prompt = rawPreserved;
    } else {
      raw.messages = rawPreserved;
    }
    question.raw = raw;
  }

  return { question };
}

function buildGenerateTextParams<T, W extends string>(
  witness: NormalizedWitness<W>,
  options: CorroborateOptions<T, W>,
  outputSpec: ReturnType<typeof Output.object<T>>,
  abortSignal: AbortSignal,
): Parameters<typeof generateText>[0] {
  const params: Record<string, unknown> = {};
  const settings = witness.settings;
  if (settings !== undefined) {
    for (const key of Object.keys(settings)) {
      if (
        key === 'timeout' ||
        key === 'maxRetries' ||
        key === 'headers' ||
        key === 'providerOptions' ||
        key === 'abortSignal' ||
        key === 'model' ||
        key === 'prompt' ||
        key === 'messages' ||
        key === 'instructions' ||
        key === 'output' ||
        key === 'telemetry'
      ) {
        continue;
      }
      const val = (settings as Record<string, unknown>)[key];
      if (val !== undefined) {
        params[key] = val;
      }
    }
  }

  const timeout = settings?.timeout ?? options.timeout;
  if (timeout !== undefined) params.timeout = timeout;

  const maxRetries = settings?.maxRetries ?? options.maxRetries;
  if (maxRetries !== undefined) params.maxRetries = maxRetries;

  const headers = settings?.headers ?? options.headers;
  if (headers !== undefined) params.headers = headers;

  const providerOptions = settings?.providerOptions ?? options.providerOptions;
  if (providerOptions !== undefined) params.providerOptions = providerOptions;

  if (options.telemetry !== undefined) {
    params.telemetry = options.telemetry;
  }
  if (options.instructions !== undefined) {
    params.instructions = options.instructions;
  }
  if (options.prompt !== undefined) {
    params.prompt = options.prompt;
  } else if (options.messages !== undefined) {
    params.messages = options.messages;
  }

  params.model = witness.model;
  params.output = outputSpec;
  params.abortSignal = abortSignal;

  return params as Parameters<typeof generateText>[0];
}

function sumUsage<W extends string>(
  labels: readonly W[],
  records: ReadonlyMap<W, WitnessRecord<unknown>>,
): WitnessUsage {
  const total: WitnessUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  for (const key of USAGE_KEYS) {
    let sum = 0;
    let count = 0;
    for (const label of labels) {
      const rec = records.get(label);
      const val = rec?.usage?.[key];
      if (typeof val === 'number') {
        sum += val;
        count++;
      }
    }
    if (count > 0) {
      total[key] = sum;
    }
  }
  return total;
}

function witnessFingerprintPart<T>(record: WitnessRecord<T>): JSONValue {
  if (record.status === 'answered') {
    return {
      status: 'answered',
      requested: record.requested.canonicalId,
      served: record.served?.canonicalId ?? null,
      output: record.output as JSONValue,
    };
  }
  if (record.status === 'failed') {
    return {
      status: 'failed',
      requested: record.requested.canonicalId,
      served: record.served?.canonicalId ?? null,
      kind: record.error.kind,
    };
  }
  return {
    status: 'excluded',
    requested: record.requested.canonicalId,
    stage: record.stage,
  };
}

/**
 * Runs one multi-model corroboration session over AI SDK v7 models (§2.2).
 */
export async function corroborate<T, W extends string>(
  options: CorroborateOptions<T, W>,
): Promise<Ledger<T, W>> {
  return corroborateWithHooks(options);
}

/**
 * Internal entry point supporting comparator injection for fingerprint-scope tests (I3c).
 * Never exported from the package root.
 */
export async function corroborateWithHooks<T, W extends string>(
  options: CorroborateOptions<T, W>,
  hooks?: CorroborateInternalHooks,
): Promise<Ledger<T, W>> {
  // Step 1: validate options before any model call.
  const normalized = normalizeAndValidateOptions(options);

  // Step 2: check caller abort before doing async work.
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason;
  }

  // Step 3: resolve JSON Schema and derive plan.
  let resolvedSchema: JSONSchema7;
  try {
    resolvedSchema = (await asSchema(options.schema).jsonSchema) as JSONSchema7;
  } catch (err) {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason;
    }
    throw new DissentArgumentError(
      'invalid-option',
      'schema',
      err instanceof Error ? err.message : undefined,
    );
  }
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason;
  }
  const plan = await derivePlan(resolvedSchema, options.compare);
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason;
  }

  // Step 4: hash the question.
  const { question } = await buildQuestion(options, normalized, resolvedSchema);
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason;
  }

  // Step 5–6: normalize witnesses & pre-dispatch author exclusion.
  const recordMap = new Map<W, WitnessRecord<T>>();
  const askedWitnesses: NormalizedWitness<W>[] = [];
  const preExcludedWitnesses: Array<{ label: W; record: WitnessRecord<T> }> =
    [];

  for (const witness of normalized.witnesses) {
    if (normalized.excludeAuthor) {
      const match = matchAuthorModel(
        witness.requested,
        null,
        normalized.authorModels,
      );
      if (match !== null) {
        const record: WitnessRecord<T> = {
          status: 'excluded',
          stage: 'before-dispatch',
          match,
          requested: witness.requested,
          served: null,
          durationMs: 0,
          usage: null,
        };
        recordMap.set(witness.label, record);
        preExcludedWitnesses.push({ label: witness.label, record });
        continue;
      }
    }
    askedWitnesses.push(witness);
  }

  if (askedWitnesses.length < 2) {
    throw new DissentArgumentError(
      'too-few-witnesses-after-exclusion',
      'witnesses',
      `Only ${askedWitnesses.length} witness(es) remain after author exclusion; at least 2 are required.`,
    );
  }

  const outputSpec = Output.object<T>({
    schema: options.schema,
    ...(options.schemaName !== undefined ? { name: options.schemaName } : {}),
    ...(options.schemaDescription !== undefined
      ? { description: options.schemaDescription }
      : {}),
  });

  // Step 7–11: semaphore fan-out, prompt abort handling, result reading & guards.
  const internalController = new AbortController();
  const callerSignal = options.abortSignal;
  const callSignal =
    callerSignal !== undefined
      ? AbortSignal.any([callerSignal, internalController.signal])
      : internalController.signal;

  let terminated = false;
  let rejectControl!: (reason: unknown) => void;
  const controlPromise = new Promise<never>((_resolve, reject) => {
    rejectControl = reject;
  });
  // Attach noop handler so early rejections before Promise.race never go unhandled.
  controlPromise.catch(() => {});

  const onCallerAbort = (): void => {
    if (terminated) return;
    terminated = true;
    const reason: unknown = callerSignal?.reason;
    internalController.abort(reason);
    rejectControl(reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      throw callerSignal.reason;
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const notifyWitness = (label: W, record: WitnessRecord<T>): void => {
    if (
      terminated ||
      callerSignal?.aborted ||
      options.onWitness === undefined
    ) {
      return;
    }
    try {
      options.onWitness(label, record);
    } catch (callbackErr) {
      if (!terminated) {
        terminated = true;
        internalController.abort(callbackErr);
        rejectControl(callbackErr);
      }
    }
  };

  for (const pre of preExcludedWitnesses) {
    if (terminated) break;
    notifyWitness(pre.label, pre.record);
  }

  type WitnessCallResult = {
    output: T;
    finishReason: FinishReason;
    usage: LanguageModelUsage;
    warnings: CallWarning[] | undefined;
    finalStep: { response: { modelId?: string } };
  };

  const runWitness = async (witness: NormalizedWitness<W>): Promise<void> => {
    if (terminated || callerSignal?.aborted) return;

    const startMs = performance.now();
    let result: WitnessCallResult | undefined;

    let record: WitnessRecord<T>;
    try {
      const params = buildGenerateTextParams(
        witness,
        options,
        outputSpec,
        callSignal,
      );
      hooks?.onGenerateTextParams?.(params);
      result = (await generateText(params)) as unknown as WitnessCallResult;
      const obtained = result!;
      const rawOutput = obtained.output;
      const finishReason = obtained.finishReason;
      const usage = mapUsage(obtained.usage) ?? {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      };
      const warnings = sanitizeWarnings(
        obtained.warnings,
        normalized.maxErrorTextBytes,
      );
      const served = toServedIdentity(
        witness.requested,
        obtained.finalStep?.response?.modelId,
      );

      // Guard output (JSON-only + byte cap + object shape)
      const canon = canonicalJson(rawOutput);
      const byteLen = utf8ByteLength(canon);
      if (byteLen > normalized.maxOutputBytes) {
        throw new OutputTooLargeError(byteLen, normalized.maxOutputBytes);
      }
      const cleanOutput = JSON.parse(canon) as T;
      if (!isPlainObject(cleanOutput)) {
        throw new NoObjectGeneratedError({
          message: 'Generated output must be a JSON object.',
          text: canon,
          response: {
            id: '',
            timestamp: new Date(0),
            modelId:
              obtained.finalStep?.response?.modelId ??
              witness.requested.modelId,
          },
          usage: obtained.usage,
          finishReason,
        });
      }
      const durationMs = Math.max(0, Math.round(performance.now() - startMs));

      if (normalized.excludeAuthor && served !== null) {
        const postMatch = matchAuthorModel(
          witness.requested,
          served,
          normalized.authorModels,
        );
        if (postMatch !== null) {
          record = {
            status: 'excluded',
            stage: 'after-response',
            match: postMatch,
            requested: witness.requested,
            served,
            durationMs,
            output: cleanOutput,
            usage,
          };
          recordMap.set(witness.label, record);
          notifyWitness(witness.label, record);
          return;
        }
      }

      record = {
        status: 'answered',
        requested: witness.requested,
        served,
        durationMs,
        output: cleanOutput,
        finishReason,
        usage,
        warnings,
      };
    } catch (caught) {
      if (terminated || callerSignal?.aborted) {
        return;
      }
      const durationMs = Math.max(0, Math.round(performance.now() - startMs));
      const partialResult = result;
      const errorObj: WitnessError = classifyWitnessError(
        caught,
        partialResult !== undefined
          ? {
              finishReason: partialResult.finishReason,
              usage: partialResult.usage,
            }
          : undefined,
        normalized.maxErrorTextBytes,
      );

      const served =
        partialResult !== undefined
          ? toServedIdentity(
              witness.requested,
              partialResult.finalStep?.response?.modelId,
            )
          : null;

      let usage: WitnessUsage | null = null;
      if (partialResult !== undefined) {
        usage = mapUsage(partialResult.usage);
      } else if (
        typeof caught === 'object' &&
        caught !== null &&
        'usage' in caught
      ) {
        usage = mapUsage(
          (caught as { usage?: Parameters<typeof mapUsage>[0] }).usage,
        );
      }

      record = {
        status: 'failed',
        requested: witness.requested,
        served,
        durationMs,
        error: errorObj,
        usage,
      };
    }

    if (terminated || callerSignal?.aborted) {
      return;
    }
    recordMap.set(witness.label, record);
    notifyWitness(witness.label, record);
  };

  let nextIdx = 0;
  const workerCount = Math.min(
    normalized.maxConcurrency,
    askedWitnesses.length,
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < askedWitnesses.length) {
      if (terminated || callerSignal?.aborted) return;
      const idx = nextIdx;
      nextIdx++;
      await runWitness(askedWitnesses[idx]!);
    }
  });
  const allWorkers = Promise.all(workers);
  allWorkers.catch(() => {});

  try {
    await Promise.race([allWorkers, controlPromise]);
  } finally {
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  if (callerSignal?.aborted) {
    throw callerSignal.reason;
  }

  // Step 12: assemble ledger cleanly in sorted label order.
  const sortedLabels = normalized.witnesses.map(w => w.label);
  const witnessEntries: Array<[W, WitnessRecord<T>]> = [];
  const witnessList: Array<{ label: W; record: WitnessRecord<T> }> = [];
  const answeredOutputs: AnsweredOutput<W>[] = [];
  const usageEntries: Array<[W, WitnessUsage | null]> = [];
  const witnessFpEntries: Array<[W, JSONValue]> = [];

  let answered = 0;
  let failed = 0;
  let excluded = 0;

  for (const label of sortedLabels) {
    const rec = recordMap.get(label)!;
    witnessEntries.push([label, rec]);
    witnessList.push({ label, record: rec });
    usageEntries.push([label, rec.usage]);
    witnessFpEntries.push([label, witnessFingerprintPart(rec)]);

    if (rec.status === 'answered') {
      answered++;
      answeredOutputs.push({
        witness: label,
        output: rec.output as JSONValue,
      });
    } else if (rec.status === 'failed') {
      failed++;
    } else {
      excluded++;
    }
  }

  const quorum: Quorum = {
    listed: sortedLabels.length,
    asked: askedWitnesses.length,
    answered,
    failed,
    excluded,
  };

  const compareFn = hooks?.compareFields ?? defaultCompareFields;
  const fields = compareFn<W>(plan.fields, answeredOutputs);
  const coverage = computeCoverage(plan.fields, fields);
  const { independence, witnessFindings } = analyzeIndependence(
    witnessList,
    normalized.authorModels,
  );
  const comparisonFindings = collectComparisonFindings({
    answered: quorum.answered,
    planFields: plan.fields,
    fieldResults: fields,
    coverage,
    strictCoverage: normalized.strictCoverage,
  });
  const findings = sortFindings([...witnessFindings, ...comparisonFindings]);
  const advisory = computeAdvisory(findings);

  const ledgerFingerprint = await sha256Hex(
    canonicalJson({
      protocol: 'dissent-ledger/1',
      question: question.fingerprint,
      plan: plan.fingerprint,
      witnesses: toSortedNullProtoRecord(witnessFpEntries),
    }),
  );

  return {
    protocol: 'dissent-ledger/1',
    fingerprint: ledgerFingerprint,
    question,
    plan,
    witnesses: toSortedNullProtoRecord(witnessEntries),
    quorum,
    independence,
    fields,
    coverage,
    findings,
    advisory,
    usage: {
      perWitness: toSortedNullProtoRecord(usageEntries),
      total: sumUsage(sortedLabels, recordMap),
    },
    createdAt: new Date().toISOString(),
  };
}
