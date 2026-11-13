import { DissentArgumentError } from '../errors.js';
import { MAX_VALUE_DEPTH } from './canonical-json.js';
import { sha256HexBytes } from './sha256.js';

import type { JSONValue } from '../types.js';

export type HashFormArgument = 'prompt' | 'messages' | 'instructions';

/**
 * Maps the caller's `instructions`, `prompt` or `messages` to a JSON value (§4.2).
 * Strings get CRLF/CR → LF when `normalize` is true; bytes become `{ $bytes }`;
 * `URL` becomes `{ $url }`. Anything else that is not plain JSON throws
 * `DissentArgumentError('invalid-option', argument)`.
 */
export async function hashForm(
  value: unknown,
  normalize: boolean,
  argument: HashFormArgument,
): Promise<JSONValue> {
  return map(value, normalize, argument, 0, new WeakSet<object>());
}

async function map(
  value: unknown,
  normalize: boolean,
  argument: HashFormArgument,
  depth: number,
  stack: WeakSet<object>,
): Promise<JSONValue> {
  if (typeof value === 'string') {
    return normalize
      ? value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      : value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw invalid(argument, 'non-finite number');
  }
  if (typeof value !== 'object') throw invalid(argument, typeof value);

  if (value instanceof ArrayBuffer) {
    return bytesForm(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return bytesForm(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (value instanceof URL) return { $url: value.href };

  if (depth >= MAX_VALUE_DEPTH) throw invalid(argument, 'nesting too deep');
  if (stack.has(value)) throw invalid(argument, 'cycle');

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const out: JSONValue[] = [];
      for (const item of value as unknown[]) {
        out.push(await map(item, normalize, argument, depth + 1, stack));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw invalid(argument, 'non-plain object');
    }
    const out: Record<string, JSONValue> = {};
    for (const key of Object.keys(value)) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      // defineProperty keeps an own `__proto__` key as data (§12.2).
      Object.defineProperty(out, key, {
        value: await map(member, normalize, argument, depth + 1, stack),
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

async function bytesForm(bytes: Uint8Array): Promise<JSONValue> {
  return {
    $bytes: { sha256: await sha256HexBytes(bytes), length: bytes.byteLength },
  };
}

function invalid(
  argument: HashFormArgument,
  what: string,
): DissentArgumentError {
  return new DissentArgumentError(
    'invalid-option',
    argument,
    `"${argument}" contains a value that cannot be hashed (${what}).`,
  );
}
