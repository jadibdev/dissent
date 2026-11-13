import { describe, expect, it, vi } from 'vitest';

import { NonJsonValueError } from '../errors.js';
import { canonicalJson, MAX_VALUE_DEPTH } from './canonical-json.js';

function thrown(value: unknown): NonJsonValueError {
  try {
    canonicalJson(value);
  } catch (error) {
    expect(NonJsonValueError.isInstance(error)).toBe(true);
    return error as NonJsonValueError;
  }
  throw new Error('expected canonicalJson to throw');
}

function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = [value];
  return value;
}

describe('canonicalJson', () => {
  it('2.1 sorts keys by UTF-16 code units, including surrogate pairs (I3)', () => {
    // U+10000 is the surrogate pair D800 DC00; U+FF5E is the single unit FF5E. D800 < FF5E.
    const out = canonicalJson({ '～': 1, '\u{10000}': 2, b: 3, a: 4 });
    expect(out).toBe('{"a":4,"b":3,"\u{10000}":2,"～":1}');
  });

  it('2.1 does not normalize Unicode: é and e + combining acute stay distinct (I3)', () => {
    const composed = 'é';
    const decomposed = 'é';
    expect(canonicalJson({ [composed]: 1, [decomposed]: 2 })).toBe(
      `{"${decomposed}":2,"${composed}":1}`,
    );
  });

  it('2.1 is independent of insertion order (I3)', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 }),
    );
  });

  it('2.2 serializes numbers per RFC 8785 (I3)', () => {
    const cases: Array<[number, string]> = [
      [1.0, '1'],
      [-0, '0'],
      [0, '0'],
      [1e21, '1e+21'],
      [1e-7, '1e-7'],
      [5e-324, '5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [9007199254740991, '9007199254740991'],
      [333333333.3333332, '333333333.3333332'],
      [4.5, '4.5'],
      [0.002, '0.002'],
      [1e30, '1e+30'],
    ];
    for (const [input, expected] of cases)
      expect(canonicalJson(input)).toBe(expected);
  });

  it('2.2 emits no whitespace and keeps array order (I3)', () => {
    expect(canonicalJson({ a: [3, 1, 2], b: 'x y', c: null, d: true })).toBe(
      '{"a":[3,1,2],"b":"x y","c":null,"d":true}',
    );
  });

  it('2.3 rejects non-JSON values with a JSON Pointer path and `found` (I7)', () => {
    class Foo {
      x = 1;
    }
    const cases: Array<[unknown, string, string]> = [
      [{ a: { b: new Date(0) } }, '/a/b', 'Date'],
      [{ m: new Map() }, '/m', 'Map'],
      [[new Set()], '/0', 'Set'],
      [{ r: /x/ }, '/r', 'RegExp'],
      [{ f: new Foo() }, '/f', 'class-instance:Foo'],
      [{ n: Number.NaN }, '/n', 'NaN'],
      [{ n: Infinity }, '/n', 'Infinity'],
      [{ n: -Infinity }, '/n', 'Infinity'],
      [{ n: 10n }, '/n', 'bigint'],
      [{ f: () => 1 }, '/f', 'function'],
      [{ s: Symbol('x') }, '/s', 'symbol'],
      [{ list: [1, undefined, 3] }, '/list/1', 'undefined-in-array'],
      [undefined, '', 'undefined'],
      [{ 'a/b': new Date(0) }, '/a~1b', 'Date'],
    ];
    for (const [value, path, found] of cases) {
      const error = thrown(value);
      expect([error.path, error.found]).toEqual([path, found]);
    }
  });

  it('2.3 rejects a cycle and reports its path (I7)', () => {
    const a: Record<string, unknown> = { k: 1 };
    a.self = { back: a };
    const error = thrown(a);
    expect(error.found).toBe('cycle');
    expect(error.path).toBe('/self/back');
  });

  it('2.3 allows a shared (non-cyclic) reference twice (I7)', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });

  it('2.3 rejects depth 65 and accepts depth 64 (I7)', () => {
    expect(MAX_VALUE_DEPTH).toBe(64);
    expect(() => canonicalJson(nest(64))).not.toThrow();
    const error = thrown(nest(65));
    expect(error.found).toBe('depth');
    expect(error.path.split('/').length - 1).toBe(64);
  });

  it('2.3 never calls toJSON (I7)', () => {
    const toJSON = vi.fn(() => 'replaced');
    expect(thrown({ toJSON }).found).toBe('function');
    const date = new Date(0);
    date.toJSON = toJSON;
    expect(thrown(date).found).toBe('Date');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('2.3 rejects accessor properties instead of invoking them (I7)', () => {
    const getter = vi.fn(() => 1);
    const value = Object.defineProperty({}, 'x', {
      get: getter,
      enumerable: true,
    });
    expect(thrown(value).found).toBe('accessor');
    expect(getter).not.toHaveBeenCalled();
  });

  it('2.4 omits undefined object properties and keeps null (I8, I10)', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 0 })).toBe(
      '{"b":null,"c":0}',
    );
    expect(canonicalJson({ nested: { gone: undefined } })).toBe(
      '{"nested":{}}',
    );
  });

  it('2.5 accepts null-prototype objects (§12.2)', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.b = 1;
    value.a = 2;
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });

  it('2.5 serializes an own __proto__ key as data and leaves prototypes alone (§12.2)', () => {
    const parsed = JSON.parse(
      '{"__proto__":{"polluted":true},"a":1}',
    ) as Record<string, unknown>;
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"polluted":true},"a":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
