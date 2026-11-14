import { canonicalJson } from '../canonical/canonical-json.js';
import { compareUtf16 } from '../canonical/canonical-json.js';
import { isPlainObject, ownValue } from '../compare/util.js';

import type { JSONValue } from '../types.js';

const encoder = new TextEncoder();

// oxlint-disable-next-line no-control-regex -- ANSI CSI sanitization (§11.3 step 1)
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex -- ANSI OSC sanitization (§11.3 step 1)
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// oxlint-disable-next-line no-control-regex -- ANSI two-byte ESC sanitization (§11.3 step 1)
const ANSI_OTHER_RE = /\u001b[\s\S]?/g;
// Removes C0 controls except \t (0x09) and \n (0x0a), DEL (0x7f), C1 (0x80-0x9f),
// BiDi controls, and zero-width / format characters (§11.3 step 1).
const UNSAFE_CONTROLS_RE =
  // oxlint-disable-next-line no-control-regex -- intentional control/BiDi character strip (§11.3 step 1)
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

const REDACT_BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const REDACT_PREFIX_KEY_RE = /\b(?:sk|pk|rk|sess)-[A-Za-z0-9_-]{16,}/gi;
const REDACT_GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/gi;
const REDACT_KV_RE =
  /\b(api[_-]?key|x-api-key|authorization|token|secret|password)\b(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const REDACT_QUERY_RE =
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi;

const MAX_WARNINGS_PER_WITNESS = 16;

/** Strips ANSI CSI/OSC/ESC sequences and unsafe control/BiDi characters (§11.3 step 1). */
export function sanitizeControlChars(text: string): string {
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_OTHER_RE, '')
    .replace(UNSAFE_CONTROLS_RE, '');
}

/** Applies the §12.3 best-effort secret redaction patterns in order. */
export function redactSecrets(text: string): string {
  return text
    .replace(REDACT_BEARER_RE, 'Bearer [REDACTED]')
    .replace(REDACT_PREFIX_KEY_RE, '[REDACTED]')
    .replace(REDACT_GOOGLE_KEY_RE, '[REDACTED]')
    .replace(
      REDACT_KV_RE,
      (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`,
    )
    .replace(REDACT_QUERY_RE, (_m, prefix: string) => `${prefix}[REDACTED]`);
}

/** Returns UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting code points
 * and without appending an ellipsis (§12.4).
 */
export function truncateUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  let used = 0;
  let end = 0;
  for (const cp of text) {
    const len = encoder.encode(cp).byteLength;
    if (used + len > maxBytes) break;
    used += len;
    end += cp.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** Sanitizes, redacts, and caps error text (`message` or `rawText`) per §12.3–§12.4. */
export function sanitizeErrorText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  return truncateUtf8Bytes(redactSecrets(sanitizeControlChars(text)), maxBytes);
}

function toSanitizedJson(
  value: unknown,
  depth: number,
  stack: WeakSet<object>,
): JSONValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return redactSecrets(sanitizeControlChars(value));
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value !== 'object') {
    return redactSecrets(sanitizeControlChars(String(value)));
  }
  if (depth >= 16 || stack.has(value)) {
    return '[truncated]';
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const arr: JSONValue[] = [];
      for (const item of value) {
        arr.push(toSanitizedJson(item, depth + 1, stack));
      }
      return arr;
    }
    if (!isPlainObject(value)) {
      return redactSecrets(sanitizeControlChars(String(value)));
    }
    const keys = Object.keys(value).slice();
    // oxlint-disable-next-line unicorn/no-array-sort -- fresh keys copy; compareUtf16 keeps deterministic order.
    keys.sort(compareUtf16);
    const out = Object.create(null) as Record<string, JSONValue>;
    for (const key of keys) {
      const member = ownValue(value, key);
      if (member === undefined) continue;
      const cleanKey = redactSecrets(sanitizeControlChars(key));
      Object.defineProperty(out, cleanKey, {
        value: toSanitizedJson(member, depth + 1, stack),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/**
 * Normalizes SDK warnings to at most 16 canonical-JSON-safe, sanitized entries,
 * each capped at `maxErrorTextBytes` when serialized (§2.4, §12.4).
 */
export function sanitizeWarnings(
  warnings: unknown,
  maxErrorTextBytes: number,
): JSONValue[] {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  const capped = warnings.slice(0, MAX_WARNINGS_PER_WITNESS);
  const out: JSONValue[] = [];
  for (const entry of capped) {
    const clean = toSanitizedJson(entry, 0, new WeakSet<object>());
    const serialized = canonicalJson(clean);
    if (utf8ByteLength(serialized) <= maxErrorTextBytes) {
      out.push(clean);
      continue;
    }
    const wrapperOverhead = utf8ByteLength('{"truncated":""}');
    const budget = Math.max(0, maxErrorTextBytes - wrapperOverhead);
    // Account for JSON escaping inflation conservatively if quotes/backslashes exist.
    let { text } = truncateUtf8Bytes(serialized, budget);
    while (
      utf8ByteLength(canonicalJson({ truncated: text })) > maxErrorTextBytes &&
      text.length > 0
    ) {
      text = text.slice(0, Math.floor(text.length * 0.8));
    }
    out.push({ truncated: text });
  }
  return out;
}
