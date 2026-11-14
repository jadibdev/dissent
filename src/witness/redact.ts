import { canonicalJson, compareUtf16 } from '../canonical/canonical-json.js';
import { isPlainObject, ownValue } from '../compare/util.js';
import { redactSecrets, sanitizeControlChars } from '../sanitize.js';

import type { JSONValue } from '../types.js';

export { redactSecrets, sanitizeControlChars };

const encoder = new TextEncoder();

const MAX_WARNINGS_PER_WITNESS = 16;

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
