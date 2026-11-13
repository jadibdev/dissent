import type {
  FinishReason,
  FlexibleSchema,
  Instructions,
  JSONValue,
  LanguageModel,
  LanguageModelCallOptions,
  ModelMessage,
  RequestOptions,
  TelemetryOptions,
  TimeoutConfiguration,
  ToolSet,
  generateText,
} from 'ai';

export type { JSONValue };

type GenerateTextProviderOptions = Parameters<
  typeof generateText
>[0]['providerOptions'];

// ---- Options (§2.2, §5.5) ----

/** Per-witness overrides. Same meaning as the `generateText` options of the same name. */
export type WitnessSettings = LanguageModelCallOptions & {
  timeout?: TimeoutConfiguration<ToolSet>;
  maxRetries?: number;
  headers?: RequestOptions<ToolSet>['headers'];
  providerOptions?: GenerateTextProviderOptions;
};

export type WitnessEntry =
  | LanguageModel
  | { model: LanguageModel; settings?: WitnessSettings };

export type ComparatorOverride =
  | 'exact'
  | 'set'
  | 'none'
  | { comparator: 'exact' | 'set' | 'none'; onSplit?: Severity }
  | { onSplit: Severity }
  | { tolerance: ToleranceSpec; onSplit?: Severity }
  | { key: string; onSplit?: Severity };

export type CompareOverrides<T> = Partial<
  Record<
    (T extends object ? Extract<keyof T, string> : never) | `/${string}`,
    ComparatorOverride
  >
>;

export type CorroborateOptions<T, W extends string> = {
  /** Two to 16 witnesses. Keys are labels. */
  witnesses: Record<W, WitnessEntry>;
  /** The only schema input in v0.1. Its JSON Schema root MUST be an object. */
  schema: FlexibleSchema<T>;
  schemaName?: string;
  schemaDescription?: string;
  instructions?: Instructions;
  compare?: CompareOverrides<T>;
  provenance?: {
    /** Each entry MUST be `provider/modelId`. */
    authorModels: readonly string[];
    /** Default false. When true, matching witnesses are excluded and listed. */
    excludeAuthor?: boolean;
  };
  /** Default 'normalize-for-hash'. Never changes what is sent. */
  lineEndings?: 'normalize-for-hash' | 'preserve';
  /** Default 'hash'. 'full' copies the input into `ledger.question.raw`. */
  includeInput?: 'hash' | 'full';
  /** Default false. When true, `coverage-low` is critical. */
  strictCoverage?: boolean;
  /** Default 8. Integer in [1, 16]. */
  maxConcurrency?: number;
  /** Default 1_048_576. UTF-8 bytes of canonical JSON per witness output. */
  maxOutputBytes?: number;
  /** Default 2048. UTF-8 bytes per error `message` and per `rawText`. */
  maxErrorTextBytes?: number;
  /** Called once per witness as it settles, in settle order. */
  onWitness?: (label: W, record: WitnessRecord<T>) => void;
  abortSignal?: AbortSignal;
  timeout?: TimeoutConfiguration<ToolSet>;
  maxRetries?: number;
  headers?: RequestOptions<ToolSet>['headers'];
  providerOptions?: GenerateTextProviderOptions;
  telemetry?: TelemetryOptions;
} & (
  | { prompt: string | ModelMessage[]; messages?: never }
  | { messages: ModelMessage[]; prompt?: never }
);

// ---- Ledger (§2.3) ----

export type Severity = 'info' | 'warn' | 'critical';
export type Advisory = 'clear' | 'warnings' | 'review-required';

export type Ledger<T, W extends string = string> = {
  protocol: 'dissent-ledger/1';
  /** Inputs only (§4.5, I3). */
  fingerprint: string;
  question: QuestionRecord;
  plan: { fingerprint: string; fields: Record<string, FieldPlan> };
  witnesses: Record<W, WitnessRecord<T>>;
  quorum: Quorum;
  independence: Independence<W>;
  fields: Record<string, FieldResult<W>>;
  coverage: Coverage;
  findings: Finding<W>[];
  advisory: Advisory;
  usage: { perWitness: Record<W, WitnessUsage | null>; total: WitnessUsage };
  /** ISO-8601 UTC with milliseconds. Not fingerprinted. */
  createdAt: string;
};

export type QuestionRecord = {
  fingerprint: string;
  inputKind: 'prompt' | 'messages';
  /** sha256 of canonical JSON of the hash form of `prompt` or `messages` (§4.2). */
  inputHash: string;
  /** null when `instructions` was not given. */
  instructionsHash: string | null;
  /** sha256 of canonical JSON of { jsonSchema, name, description } (absent keys omitted). */
  schemaHash: string;
  /** UTF-8 byte length of the canonical JSON whose hash is `inputHash`. */
  inputBytes: number;
  lineEndings: 'normalized-for-hash' | 'preserved';
  /** Only with includeInput: 'full'. JSON-safe form of the input as sent (§4.2). */
  raw?: { instructions?: JSONValue; prompt?: JSONValue; messages?: JSONValue };
};

export type Quorum = {
  listed: number;
  asked: number;
  answered: number;
  failed: number;
  excluded: number;
};

// ---- Witnesses (§2.4) ----

export type ModelIdentity = {
  provider: string;
  modelId: string;
  /** Matching key (§8.2). Lowercase. */
  canonicalId: string;
  /** Provider prefix of canonicalId, or '(default)'. */
  providerKey: string;
};

export type WitnessUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

type WitnessBase = { requested: ModelIdentity; durationMs: number };

export type WitnessRecord<T> =
  | (WitnessBase & {
      status: 'answered';
      served: ModelIdentity | null;
      output: T;
      finishReason: FinishReason;
      usage: WitnessUsage;
      /** Each SDK warning as sanitized JSON, at most 16 entries. */
      warnings: JSONValue[];
    })
  | (WitnessBase & {
      status: 'failed';
      served: ModelIdentity | null;
      error: WitnessError;
      usage: WitnessUsage | null;
    })
  | (WitnessBase & {
      status: 'excluded';
      stage: 'before-dispatch' | 'after-response';
      match: { authorModel: string; on: 'requested' | 'served' };
      served: ModelIdentity | null;
      output?: T;
      usage: WitnessUsage | null;
    });

export type WitnessErrorKind =
  | 'invalid-output'
  | 'truncated'
  | 'refused'
  | 'api-error'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export type WitnessError = {
  kind: WitnessErrorKind;
  /** error.name, sanitized; 'NonJsonValue' / 'OutputTooLarge' for Dissent's own guards. */
  name: string;
  /** Sanitized, redacted, capped (§12.3). */
  message: string;
  messageTruncated: boolean;
  finishReason?: FinishReason;
  statusCode?: number;
  isRetryable?: boolean;
  rawText?: string;
  rawTextTruncated?: boolean;
  /** Only for Dissent's own guards: JSON Pointer of the offending value. */
  path?: string;
};

// ---- Plan (§2.5) ----

export type Comparator =
  | 'exact'
  | 'tolerance'
  | 'set'
  | 'keyed-set'
  | 'discriminated-union'
  | 'none';

export type PlanReason =
  | 'default-by-type'
  | 'caller-override'
  | 'nullable-unwrap'
  | 'ref-resolved'
  | 'discriminated-union'
  | 'policy'
  | 'unsupported';

export type NotComparedDetail =
  | 'free-text'
  | 'number-without-tolerance'
  | 'number-array'
  | 'caller-none'
  | 'external-ref'
  | 'ref-cycle'
  | 'depth-exceeded'
  | 'union'
  | 'all-of'
  | 'conditional'
  | 'record'
  | 'additional-properties'
  | 'tuple'
  | 'nested-array'
  | 'object-array-requires-key'
  | 'nested-composite'
  | 'multi-type'
  | 'untyped'
  | 'not'
  | 'invalid-ref';

type PlanCommon = { reasons: PlanReason[]; nullable: boolean };

export type ToleranceSpec = { absolute?: number; relative?: number };

export type LeafPlan =
  | (PlanCommon & { comparator: 'exact'; onSplit: Severity })
  | (PlanCommon & {
      comparator: 'tolerance';
      tolerance: ToleranceSpec;
      onSplit: Severity;
    })
  | (PlanCommon & { comparator: 'set'; onSplit: Severity })
  | (PlanCommon & {
      comparator: 'none';
      reason: 'policy' | 'unsupported';
      detail: NotComparedDetail;
    });

export type FieldPlan =
  | LeafPlan
  | (PlanCommon & {
      comparator: 'keyed-set';
      key: string;
      onSplit: Severity;
      /** Keyed by JSON Pointer relative to the item. */
      itemFields: Record<string, LeafPlan>;
    })
  | (PlanCommon & {
      comparator: 'discriminated-union';
      discriminator: string;
      onSplit: Severity;
      /** Keyed by canonical JSON of the discriminator value. */
      branches: Record<string, Record<string, LeafPlan>>;
    });

// ---- Results (§2.6) ----

export type FieldStatus = 'agree' | 'split' | 'insufficient' | 'not-compared';

type ResultCommon<W extends string> = {
  status: FieldStatus;
  /** Answering witnesses: the denominator of every support count. */
  answered: number;
  presented: W[];
  missing: W[];
  nulls: W[];
};

export type ValueGroup<W extends string> = {
  value: JSONValue;
  witnesses: W[];
  support: number;
};

export type ExactResult<W extends string> = ResultCommon<W> & {
  comparator: 'exact';
  groups: ValueGroup<W>[];
};

export type ToleranceResult<W extends string> = ResultCommon<W> & {
  comparator: 'tolerance';
  tolerance: ToleranceSpec;
  min?: number;
  max?: number;
  spread?: number;
  groups: Array<{
    min: number;
    max: number;
    values: ValueGroup<W>[];
    support: number;
  }>;
  nullGroup?: { witnesses: W[]; support: number };
};

export type SetResult<W extends string> = ResultCommon<W> & {
  comparator: 'set';
  union: JSONValue[];
  intersection: JSONValue[];
  items: Array<{ item: JSONValue; witnesses: W[]; support: number }>;
  jaccard?: number;
  duplicates: W[];
};

export type NotComparedResult<W extends string> = ResultCommon<W> & {
  comparator: 'none';
  status: 'not-compared';
  reason: 'policy' | 'unsupported' | 'duplicate-key';
  detail: NotComparedDetail | 'duplicate-key';
  values: Array<{ witness: W; value: JSONValue }>;
  duplicateKeyWitnesses?: W[];
};

export type LeafResult<W extends string> =
  | ExactResult<W>
  | ToleranceResult<W>
  | SetResult<W>
  | NotComparedResult<W>;

export type KeyedSetResult<W extends string> = ResultCommon<W> & {
  comparator: 'keyed-set';
  key: string;
  keys: Omit<SetResult<W>, keyof ResultCommon<W> | 'comparator' | 'duplicates'>;
  items: Array<{
    key: JSONValue;
    witnesses: W[];
    fields: Record<string, LeafResult<W>>;
  }>;
};

export type UnionResult<W extends string> = ResultCommon<W> & {
  comparator: 'discriminated-union';
  discriminator: string;
  choice: ExactResult<W>;
  branches: Array<{
    value: JSONValue;
    witnesses: W[];
    fields: Record<string, LeafResult<W>>;
  }>;
};

export type FieldResult<W extends string> =
  | LeafResult<W>
  | KeyedSetResult<W>
  | UnionResult<W>;

// ---- Coverage, findings, independence (§2.7) ----

export type Coverage = {
  fields: number;
  compared: number;
  notComparedByPolicy: number;
  unsupported: number;
  failedAtRuntime: number;
  ratio: number;
  byReason: Record<string, number>;
};

export type FindingCode =
  | 'insufficient-quorum'
  | 'witness-failed'
  | 'witness-excluded'
  | 'truncated-output'
  | 'field-split'
  | 'field-partial'
  | 'duplicate-key'
  | 'unsupported-schema'
  | 'coverage-low'
  | 'duplicate-served-model'
  | 'single-provider'
  | 'self-grading';

export type Finding<W extends string = string> = {
  code: FindingCode;
  severity: Severity;
  path?: string;
  within?: { key: JSONValue } | { branch: JSONValue };
  subpath?: string;
  witnesses?: W[];
  data?: Record<string, JSONValue>;
};

export type Independence<W extends string> = {
  uniqueRequestedProviders: number;
  duplicateServedModels: Array<{ canonicalId: string; witnesses: W[] }>;
  sameProviderGroups: Array<{ providerKey: string; witnesses: W[] }>;
  selfGradingWitnesses: Array<{
    witness: W;
    authorModel: string;
    on: 'requested' | 'served';
  }>;
  excludedWitnesses: Array<{
    witness: W;
    stage: 'before-dispatch' | 'after-response';
    authorModel: string;
    on: 'requested' | 'served';
  }>;
};

// ---- Evidence and adjudication (§2.8) ----

export type EvidenceOutcome = 'pass' | 'fail' | 'error' | 'unknown';

export type EvidenceClaim =
  | { path: string; value: JSONValue }
  | { scope: 'artifact' };

export type Evidence = {
  /** Who produced it, e.g. 'vitest'. 1–128 chars after sanitizing. */
  source: string;
  outcome: EvidenceOutcome;
  claim?: EvidenceClaim;
  details?: Record<string, JSONValue>;
  /** @experimental Structured facts about the run, carried into the fingerprint. */
  claims?: Record<string, JSONValue>;
  /** @experimental Execution environment receipt (§10.5). */
  receipt?: ExecutionEnvironmentReceipt;
};

/** @experimental */
export type ExecutionEnvironmentReceipt = {
  provider: string;
  /** 'offline-verification-v1' is the only profile that validates. */
  profile: string;
  runtimeImageDigest: string;
  networkPolicyEnforced: boolean;
  networkPolicySha256: string;
  receiptId: string;
  region: string;
};

export type ReceiptCheck =
  | { valid: true }
  | {
      valid: false;
      reason:
        | 'malformed'
        | 'wrong-profile'
        | 'network-not-enforced'
        | 'policy-mismatch'
        | 'image-mismatch';
    };

export type AdjudicateOptions = {
  /** Default false. */
  escalateOnReview?: boolean;
  /** @experimental Artifact evidence with a missing or invalid receipt counts as 'unknown'. */
  requireOfflineReceipt?:
    | boolean
    | { networkPolicySha256?: string; runtimeImageDigest?: string };
};

export type Verdict = 'confirmed' | 'rejected' | 'uncertain';
export type VerdictReason =
  | 'no-artifact-evidence'
  | 'artifact-evidence-failed'
  | 'artifact-evidence-inconclusive'
  | 'artifact-evidence-passed'
  | 'escalated-on-review';

export type Settlement<W extends string> = {
  path: string;
  value: JSONValue;
  source: string;
  outcome: EvidenceOutcome;
  comparator: Exclude<Comparator, 'none'> | 'not-comparable';
  witnessesAgreeing: W[];
  witnessesDissenting: W[];
  witnessesSilent: W[];
};

export type Adjudication<W extends string = string> = {
  protocol: 'dissent-adjudication/1';
  ledgerFingerprint: string;
  fingerprint: string;
  settlements: Settlement<W>[];
  conflicts: Array<{ path: string; sources: string[] }>;
  verdict: Verdict;
  verdictReason: VerdictReason;
  artifactEvidence: {
    pass: number;
    fail: number;
    error: number;
    unknown: number;
  };
  receiptChecks: Array<{
    source: string;
    receiptId: string | null;
    check: ReceiptCheck;
  }>;
  unbound: Array<{
    source: string;
    outcome: EvidenceOutcome;
    reason: 'no-claim' | 'unknown-path';
  }>;
};

// ---- Rendering (§2.9) ----

export type FormatLedgerOptions = {
  /** Default 'markdown'. */
  format?: 'markdown' | 'ascii';
  adjudication?: Adjudication;
  /** Default 120. */
  maxInlineChars?: number;
  /** Default 4000. */
  maxBlockChars?: number;
  /** Default false. */
  showOutputs?: boolean;
};
