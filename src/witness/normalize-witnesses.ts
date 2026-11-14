import {
  isPlainObject,
  ownValue,
  sortLabels,
  sortWith,
} from '../compare/util.js';
import { compareUtf16 } from '../canonical/canonical-json.js';
import { DissentArgumentError } from '../errors.js';

import type { LanguageModel } from 'ai';

import type {
  CorroborateOptions,
  ModelIdentity,
  WitnessEntry,
  WitnessSettings,
} from '../types.js';

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_LABELS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasownproperty',
  'tostring',
  'valueof',
]);

export const DEFAULT_MAX_CONCURRENCY = 8;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_MAX_ERROR_TEXT_BYTES = 2048;

export type NormalizedWitness<W extends string> = {
  label: W;
  model: LanguageModel;
  settings: WitnessSettings | undefined;
  requested: ModelIdentity;
};

export type NormalizedOptions<W extends string> = {
  witnesses: NormalizedWitness<W>[];
  authorModels: string[];
  excludeAuthor: boolean;
  lineEndings: 'normalize-for-hash' | 'preserve';
  includeInput: 'hash' | 'full';
  strictCoverage: boolean;
  maxConcurrency: number;
  maxOutputBytes: number;
  maxErrorTextBytes: number;
};

function isWitnessWrapper(
  entry: unknown,
): entry is { model: LanguageModel; settings?: WitnessSettings } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    Object.hasOwn(entry, 'model') &&
    !Object.hasOwn(entry, 'specificationVersion')
  );
}

function isValidLanguageModel(model: unknown): model is LanguageModel {
  if (typeof model === 'string') {
    return model.trim().length > 0;
  }
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    return false;
  }
  const m = model as Record<string, unknown>;
  return (
    typeof m.specificationVersion === 'string' &&
    typeof m.provider === 'string' &&
    typeof m.modelId === 'string' &&
    m.modelId.length > 0
  );
}

function isGatewayProvider(provider: string): boolean {
  return (
    provider === 'gateway' ||
    provider === 'gateway-string' ||
    provider.startsWith('gateway.')
  );
}

export function hasNonEmptySlashParts(id: string): boolean {
  const slash = id.indexOf('/');
  return slash > 0 && slash < id.length - 1;
}

/**
 * Computes the requested `ModelIdentity` for a model string or instance (§8.1–§8.2).
 */
export function toRequestedIdentity(model: LanguageModel): ModelIdentity {
  const provider =
    typeof model === 'string' ? 'gateway-string' : model.provider;
  const modelId = typeof model === 'string' ? model : model.modelId;

  if (isGatewayProvider(provider) && hasNonEmptySlashParts(modelId)) {
    const canonicalId = modelId.toLowerCase();
    const slash = canonicalId.indexOf('/');
    return {
      provider,
      modelId,
      canonicalId,
      providerKey: canonicalId.slice(0, slash),
    };
  }
  if (provider === 'gateway-string') {
    return {
      provider,
      modelId,
      canonicalId: modelId.toLowerCase(),
      providerKey: '(default)',
    };
  }
  const providerPrefix = provider.split('.')[0] || '(default)';
  const canonicalId = `${providerPrefix}/${modelId}`.toLowerCase();
  const slash = canonicalId.indexOf('/');
  return {
    provider,
    modelId,
    canonicalId,
    providerKey: canonicalId.slice(0, slash),
  };
}

/**
 * Computes the served `ModelIdentity` from `finalStep.response.modelId` (§8.2).
 */
export function toServedIdentity(
  requested: ModelIdentity,
  servedModelId: string | undefined | null,
): ModelIdentity | null {
  if (typeof servedModelId !== 'string' || servedModelId.length === 0) {
    return null;
  }
  if (
    isGatewayProvider(requested.provider) &&
    hasNonEmptySlashParts(servedModelId)
  ) {
    const canonicalId = servedModelId.toLowerCase();
    const providerKey = canonicalId.slice(0, canonicalId.indexOf('/'));
    return {
      provider: providerKey,
      modelId: servedModelId,
      canonicalId,
      providerKey,
    };
  }
  const canonicalId = `${requested.providerKey}/${servedModelId}`.toLowerCase();
  return {
    provider: requested.providerKey,
    modelId: servedModelId,
    canonicalId,
    providerKey: requested.providerKey,
  };
}

function normalizeAuthorModels(raw: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new DissentArgumentError(
        'invalid-author-model',
        `provenance.authorModels[${i}]`,
      );
    }
    const trimmed = entry.trim().toLowerCase();
    const parts = trimmed.split('/');
    if (
      parts.length !== 2 ||
      parts[0]!.length === 0 ||
      parts[1]!.length === 0
    ) {
      throw new DissentArgumentError(
        'invalid-author-model',
        `provenance.authorModels[${i}]`,
        `Invalid authorModel "${entry}": expected "provider/modelId".`,
      );
    }
    normalized.push(trimmed);
  }
  return sortWith(normalized, compareUtf16);
}

function isAbortSignalLike(signal: unknown): signal is AbortSignal {
  if (typeof signal !== 'object' || signal === null) return false;
  const s = signal as Record<string, unknown>;
  return (
    typeof s.aborted === 'boolean' &&
    typeof s.addEventListener === 'function' &&
    typeof s.removeEventListener === 'function'
  );
}

function validateIntegerRange(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
  argument: string,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DissentArgumentError(
      'invalid-option',
      argument,
      `${argument} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

/**
 * Validates and normalizes `corroborate` options synchronously before any model call (§2.2.1 step 1).
 */
export function normalizeAndValidateOptions<T, W extends string>(
  options: CorroborateOptions<T, W>,
): NormalizedOptions<W> {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new DissentArgumentError('invalid-option', 'options');
  }

  const rawWitnesses = options.witnesses as unknown;
  if (
    typeof rawWitnesses !== 'object' ||
    rawWitnesses === null ||
    Array.isArray(rawWitnesses)
  ) {
    throw new DissentArgumentError('invalid-option', 'witnesses');
  }

  const rawKeys = Object.keys(rawWitnesses) as W[];
  for (const label of rawKeys) {
    if (RESERVED_LABELS.has(label.toLowerCase())) {
      throw new DissentArgumentError('reserved-label', `witnesses.${label}`);
    }
    if (!LABEL_RE.test(label)) {
      throw new DissentArgumentError('invalid-label', `witnesses.${label}`);
    }
  }
  if (rawKeys.length < 2) {
    throw new DissentArgumentError('too-few-witnesses', 'witnesses');
  }
  if (rawKeys.length > 16) {
    throw new DissentArgumentError('too-many-witnesses', 'witnesses');
  }

  const sortedLabels = sortLabels(rawKeys);
  const witnesses: NormalizedWitness<W>[] = [];
  for (const label of sortedLabels) {
    const entry = ownValue<WitnessEntry>(rawWitnesses, label);
    let model: unknown;
    let settings: WitnessSettings | undefined;
    if (isWitnessWrapper(entry)) {
      model = entry.model;
      const rawSettings = ownValue<unknown>(entry, 'settings');
      if (rawSettings !== undefined) {
        if (!isPlainObject(rawSettings)) {
          throw new DissentArgumentError(
            'invalid-witness-entry',
            `witnesses.${label}.settings`,
          );
        }
        settings = rawSettings as WitnessSettings;
      }
    } else {
      model = entry;
    }

    if (!isValidLanguageModel(model)) {
      throw new DissentArgumentError(
        'invalid-witness-entry',
        `witnesses.${label}`,
      );
    }
    witnesses.push({
      label,
      model,
      settings,
      requested: toRequestedIdentity(model),
    });
  }

  const hasPrompt = options.prompt !== undefined;
  const hasMessages = options.messages !== undefined;
  if (hasPrompt && hasMessages) {
    throw new DissentArgumentError('prompt-and-messages', 'prompt');
  }
  if (!hasPrompt && !hasMessages) {
    throw new DissentArgumentError('no-input', 'prompt');
  }

  const rawSchema = options.schema as unknown;
  if (
    rawSchema === null ||
    rawSchema === undefined ||
    (typeof rawSchema !== 'object' && typeof rawSchema !== 'function')
  ) {
    throw new DissentArgumentError('invalid-option', 'schema');
  }

  let authorModels: string[] = [];
  let excludeAuthor = false;
  if (options.provenance !== undefined) {
    const prov = options.provenance as unknown;
    if (!isPlainObject(prov) || !Array.isArray(prov.authorModels)) {
      throw new DissentArgumentError('invalid-option', 'provenance');
    }
    authorModels = normalizeAuthorModels(
      prov.authorModels as readonly string[],
    );
    if (
      prov.excludeAuthor !== undefined &&
      typeof prov.excludeAuthor !== 'boolean'
    ) {
      throw new DissentArgumentError(
        'invalid-option',
        'provenance.excludeAuthor',
      );
    }
    excludeAuthor = prov.excludeAuthor === true;
    if (excludeAuthor && authorModels.length === 0) {
      throw new DissentArgumentError(
        'exclude-without-authors',
        'provenance.excludeAuthor',
      );
    }
  }

  const lineEndings = options.lineEndings ?? 'normalize-for-hash';
  if (lineEndings !== 'normalize-for-hash' && lineEndings !== 'preserve') {
    throw new DissentArgumentError('invalid-option', 'lineEndings');
  }

  const includeInput = options.includeInput ?? 'hash';
  if (includeInput !== 'hash' && includeInput !== 'full') {
    throw new DissentArgumentError('invalid-option', 'includeInput');
  }

  if (
    options.strictCoverage !== undefined &&
    typeof options.strictCoverage !== 'boolean'
  ) {
    throw new DissentArgumentError('invalid-option', 'strictCoverage');
  }

  if (
    options.onWitness !== undefined &&
    typeof options.onWitness !== 'function'
  ) {
    throw new DissentArgumentError('invalid-option', 'onWitness');
  }

  if (
    options.abortSignal !== undefined &&
    !isAbortSignalLike(options.abortSignal)
  ) {
    throw new DissentArgumentError('invalid-option', 'abortSignal');
  }

  const maxConcurrency = validateIntegerRange(
    options.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
    1,
    16,
    'maxConcurrency',
  );
  const maxOutputBytes = validateIntegerRange(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    1024,
    67_108_864,
    'maxOutputBytes',
  );
  const maxErrorTextBytes = validateIntegerRange(
    options.maxErrorTextBytes,
    DEFAULT_MAX_ERROR_TEXT_BYTES,
    256,
    65_536,
    'maxErrorTextBytes',
  );

  return {
    witnesses,
    authorModels,
    excludeAuthor,
    lineEndings,
    includeInput,
    strictCoverage: options.strictCoverage === true,
    maxConcurrency,
    maxOutputBytes,
    maxErrorTextBytes,
  };
}
