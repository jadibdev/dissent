import { compareUtf16 } from '../canonical/canonical-json.js';

import type { JSONValue } from '../types.js';

export function normalizeJsonZeros(value: JSONValue): JSONValue {
  if (typeof value === 'number') {
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const copy: JSONValue[] = [];
    for (const orig of value) {
      const norm = normalizeJsonZeros(orig as JSONValue);
      if (!Object.is(orig, norm)) changed = true;
      copy.push(norm);
    }
    return changed ? copy : value;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const out = Object.create(null) as Record<string, JSONValue>;
    let changed = false;
    for (const k of keys) {
      const orig = ownValue<JSONValue>(value, k) as JSONValue;
      if (orig === undefined) {
        changed = true;
        continue;
      }
      const norm = normalizeJsonZeros(orig);
      if (!Object.is(orig, norm)) changed = true;
      Object.defineProperty(out, k, {
        value: norm,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return changed ? out : value;
  }
  return value;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function sortWith<T>(
  items: readonly T[],
  cmp: (a: T, b: T) => number,
): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh array copy.
  return items.slice().sort(cmp);
}

export function sortLabels<W extends string>(labels: readonly W[]): W[] {
  return sortWith(labels, compareUtf16);
}

export function ownValue<V = unknown>(obj: object, key: string): V | undefined {
  return Object.getOwnPropertyDescriptor(obj, key)?.value as V | undefined;
}

export function toSortedNullProtoRecord<V>(
  entries: ReadonlyArray<[string, V]>,
): Record<string, V> {
  const sorted = sortWith(entries, (a, b) => compareUtf16(a[0], b[0]));
  const out = Object.create(null) as Record<string, V>;
  for (const [key, value] of sorted) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
