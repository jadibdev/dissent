import {
  AISDKError,
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
} from 'ai';

import { NonJsonValueError } from '../errors.js';
import { sanitizeControlChars, sanitizeErrorText } from './redact.js';

import type { FinishReason, LanguageModelUsage } from 'ai';

import type { WitnessError, WitnessUsage } from '../types.js';

const TIMEOUT_NAMES = new Set(['TimeoutError']);
const ABORT_NAMES = new Set(['AbortError', 'ResponseAborted']);
const GATEWAY_ERROR_MARKER = Symbol.for('vercel.ai.gateway.error');
const MAX_CAUSE_DEPTH = 4;

type ApiLikeError = {
  statusCode?: unknown;
  isRetryable?: unknown;
};

function isGatewayError(error: unknown): error is ApiLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[GATEWAY_ERROR_MARKER] === true
  );
}

function isWrappedGatewayAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (GATEWAY_ERROR_MARKER in error) return false;
  if (AISDKError.isInstance(error) && error.name === 'GatewayError') {
    return true;
  }
  return error instanceof Error && error.name === 'GatewayAuthenticationError';
}

function asApiLikeError(error: unknown): ApiLikeError | undefined {
  if (APICallError.isInstance(error) || isGatewayError(error)) {
    return error;
  }
  return undefined;
}

/** Internal guard error when canonical witness output exceeds `maxOutputBytes`. */
export class OutputTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(
      `Witness output is ${bytes} UTF-8 bytes, exceeding maxOutputBytes (${maxBytes})`,
    );
    this.name = 'OutputTooLarge';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export type PartialResultContext = {
  finishReason?: FinishReason;
  usage?: LanguageModelUsage;
};

function readErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = (error as { name?: unknown }).name;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  try {
    return String(error);
  } catch {
    return 'Unprintable error';
  }
}

function matchesCauseChain(
  start: unknown,
  names: ReadonlySet<string>,
  visited: WeakSet<object>,
): boolean {
  let current: unknown = start;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if (visited.has(current)) return false;
    visited.add(current);
    const errName = readErrorName(current);
    if (errName !== undefined && names.has(errName)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function matchesErrorNames(
  error: unknown,
  names: ReadonlySet<string>,
): boolean {
  const visited = new WeakSet<object>();
  if (matchesCauseChain(error, names, visited)) return true;
  if (RetryError.isInstance(error) && error.lastError !== undefined) {
    return matchesCauseChain(error.lastError, names, visited);
  }
  return false;
}

function formatName(error: unknown, maxBytes: number): string {
  const raw = readErrorName(error) ?? typeof error;
  return sanitizeErrorText(raw, maxBytes).text || typeof error;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Maps AI SDK `LanguageModelUsage` into JSON-safe `WitnessUsage`. */
export function mapUsage(
  usage: LanguageModelUsage | undefined | null,
): WitnessUsage | null {
  if (usage === undefined || usage === null) return null;
  return {
    inputTokens: numOrNull(usage.inputTokens),
    outputTokens: numOrNull(usage.outputTokens),
    totalTokens: numOrNull(usage.totalTokens),
    cacheReadTokens: numOrNull(usage.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: numOrNull(usage.inputTokenDetails?.cacheWriteTokens),
    reasoningTokens: numOrNull(usage.outputTokenDetails?.reasoningTokens),
  };
}

/**
 * Classifies a thrown witness error per §7 rows 1–9 (row 0 caller abort is handled before calling).
 */
export function classifyWitnessError(
  error: unknown,
  context: PartialResultContext | undefined,
  maxErrorTextBytes: number,
): WitnessError {
  const msg = sanitizeErrorText(readErrorMessage(error), maxErrorTextBytes);

  // Row 1: timeout
  if (matchesErrorNames(error, TIMEOUT_NAMES)) {
    return {
      kind: 'timeout',
      name: formatName(error, maxErrorTextBytes),
      message: msg.text,
      messageTruncated: msg.truncated,
    };
  }

  // Row 2: non-caller abort
  if (matchesErrorNames(error, ABORT_NAMES)) {
    return {
      kind: 'aborted',
      name: formatName(error, maxErrorTextBytes),
      message: msg.text,
      messageTruncated: msg.truncated,
    };
  }

  // Rows 3–5: NoObjectGeneratedError / NoOutputGeneratedError
  if (
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error)
  ) {
    const fr = NoObjectGeneratedError.isInstance(error)
      ? (error.finishReason ?? context?.finishReason)
      : context?.finishReason;

    const kind =
      fr === 'length'
        ? 'truncated'
        : fr === 'content-filter'
          ? 'refused'
          : 'invalid-output';

    const out: WitnessError = {
      kind,
      name: formatName(error, maxErrorTextBytes),
      message: msg.text,
      messageTruncated: msg.truncated,
    };
    if (fr !== undefined) {
      out.finishReason = fr;
    }
    if (
      NoObjectGeneratedError.isInstance(error) &&
      typeof error.text === 'string' &&
      error.text.length > 0
    ) {
      const raw = sanitizeErrorText(error.text, maxErrorTextBytes);
      out.rawText = raw.text;
      out.rawTextTruncated = raw.truncated;
    }
    return out;
  }

  // Row 6: NonJsonValueError
  if (NonJsonValueError.isInstance(error)) {
    return {
      kind: 'invalid-output',
      name: 'NonJsonValue',
      message: msg.text,
      messageTruncated: msg.truncated,
      path: sanitizeControlChars(error.path),
    };
  }

  // Row 7: OutputTooLargeError
  if (error instanceof OutputTooLargeError) {
    return {
      kind: 'invalid-output',
      name: 'OutputTooLarge',
      message: msg.text,
      messageTruncated: msg.truncated,
    };
  }

  // Row 8: APICallError / LoadAPIKeyError / RetryError / GatewayError / wrapped Gateway auth
  if (
    APICallError.isInstance(error) ||
    LoadAPIKeyError.isInstance(error) ||
    RetryError.isInstance(error) ||
    isGatewayError(error) ||
    isWrappedGatewayAuthError(error)
  ) {
    const apiErr =
      asApiLikeError(error) ??
      (RetryError.isInstance(error)
        ? asApiLikeError(error.lastError)
        : undefined);

    const out: WitnessError = {
      kind: 'api-error',
      name: formatName(error, maxErrorTextBytes),
      message: msg.text,
      messageTruncated: msg.truncated,
    };
    if (apiErr !== undefined) {
      if (
        typeof apiErr.statusCode === 'number' &&
        Number.isFinite(apiErr.statusCode)
      ) {
        out.statusCode = apiErr.statusCode;
      }
      out.isRetryable = Boolean(apiErr.isRetryable);
    }
    return out;
  }

  // Row 9: unknown
  return {
    kind: 'unknown',
    name: formatName(error, maxErrorTextBytes),
    message: msg.text,
    messageTruncated: msg.truncated,
  };
}
