import { NonJsonValueError } from '../errors.js';
import { appendPointer } from '../paths.js';

export const MAX_VALUE_DEPTH = 64;

/**
 * RFC 8785 (JCS) serializer with a JSON-value guard (§4.1, §4.4).
 *
 * Keys sort by UTF-16 code units. `toJSON` is never called. Object properties whose value
 * is `undefined` are omitted. Anything that is not plain JSON throws `NonJsonValueError`.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '', 0, new WeakSet<object>());
}

function serialize(
  value: unknown,
  path: string,
  depth: number,
  stack: WeakSet<object>,
): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isNaN(value)) throw new NonJsonValueError(path, 'NaN');
      if (!Number.isFinite(value))
        throw new NonJsonValueError(path, 'Infinity');
      return JSON.stringify(value); // -0 → "0", 1.0 → "1", ES number formatting is JCS
    case 'bigint':
      throw new NonJsonValueError(path, 'bigint');
    case 'function':
      throw new NonJsonValueError(path, 'function');
    case 'symbol':
      throw new NonJsonValueError(path, 'symbol');
    case 'undefined':
      throw new NonJsonValueError(path, 'undefined');
    default:
      break;
  }
  if (value === null) return 'null';

  const object = value as object;
  if (depth >= MAX_VALUE_DEPTH) throw new NonJsonValueError(path, 'depth');
  if (stack.has(object)) throw new NonJsonValueError(path, 'cycle');

  const isArray = Array.isArray(object);
  if (!isArray) {
    const proto = Object.getPrototypeOf(object) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new NonJsonValueError(path, describe(object));
    }
  }

  stack.add(object);
  try {
    if (isArray) {
      const items: string[] = [];
      for (let i = 0; i < object.length; i++) {
        const itemPath = `${path}/${i}`;
        if (!Object.hasOwn(object, i) || object[i] === undefined) {
          throw new NonJsonValueError(itemPath, 'undefined-in-array');
        }
        items.push(serialize(object[i], itemPath, depth + 1, stack));
      }
      return `[${items.join(',')}]`;
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record)
      // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys returns a fresh array; toSorted needs ES2023 lib.
      .sort(compareUtf16);
    const members: string[] = [];
    for (const key of keys) {
      // Own-property read; `__proto__` own keys are plain data here.
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor !== undefined && !('value' in descriptor)) {
        throw new NonJsonValueError(appendPointer(path, key), 'accessor');
      }
      const member = descriptor?.value as unknown;
      if (member === undefined) continue;
      members.push(
        `${JSON.stringify(key)}:${serialize(member, appendPointer(path, key), depth + 1, stack)}`,
      );
    }
    return `{${members.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

/** UTF-16 code-unit order (RFC 8785 §3.2.3). Never `localeCompare`. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(object: object): string {
  if (object instanceof Date) return 'Date';
  if (object instanceof Map) return 'Map';
  if (object instanceof Set) return 'Set';
  if (object instanceof RegExp) return 'RegExp';
  const name = (object as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return typeof name === 'string' && name !== ''
    ? `class-instance:${name}`
    : 'class-instance';
}
