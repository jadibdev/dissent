import { describe, expect, it } from 'vitest';

import { DissentArgumentError } from '../errors.js';
import { canonicalJson } from './canonical-json.js';
import { hashForm } from './hash-input.js';
import { sha256Hex } from './sha256.js';

const hashOf = async (value: unknown, normalize: boolean) =>
  sha256Hex(canonicalJson(await hashForm(value, normalize, 'prompt')));

describe('hashForm', () => {
  it('2.7 CRLF, lone CR and LF give the same hash with normalize (I3, I4)', async () => {
    const lf = await hashOf('a\nb\nc', true);
    expect(await hashOf('a\r\nb\r\nc', true)).toBe(lf);
    expect(await hashOf('a\rb\rc', true)).toBe(lf);
    expect(await hashOf('a\r\nb\rc', true)).toBe(lf);
  });

  it('2.7 line endings give different hashes with preserve (I3, I4)', async () => {
    const hashes = new Set([
      await hashOf('a\nb', false),
      await hashOf('a\r\nb', false),
      await hashOf('a\rb', false),
    ]);
    expect(hashes.size).toBe(3);
  });

  it('2.7 normalizes inside messages, but not object keys (I3)', async () => {
    const form = await hashForm(
      [{ role: 'user', content: 'x\r\ny', 'k\r': 1 }],
      true,
      'messages',
    );
    expect(form).toEqual([{ role: 'user', content: 'x\ny', 'k\r': 1 }]);
  });

  it('2.7 maps bytes to { $bytes } for Uint8Array, ArrayBuffer and views (I3)', async () => {
    const hex = await sha256Hex('abc');
    const bytes = new TextEncoder().encode('abc');
    const expected = { $bytes: { sha256: hex, length: 3 } };
    expect(await hashForm(bytes, true, 'messages')).toEqual(expected);
    expect(await hashForm(bytes.buffer.slice(0), true, 'messages')).toEqual(
      expected,
    );
    const padded = new Uint8Array([0, 97, 98, 99, 0]);
    expect(await hashForm(padded.subarray(1, 4), true, 'messages')).toEqual(
      expected,
    );
    expect(
      await hashForm(new DataView(padded.buffer, 1, 3), true, 'messages'),
    ).toEqual(expected);
  });

  it('2.7 maps URL to { $url } (I3)', async () => {
    expect(
      await hashForm(new URL('https://example.com/a?b=1'), true, 'messages'),
    ).toEqual({
      $url: 'https://example.com/a?b=1',
    });
  });

  it('2.7 drops undefined-valued keys and keeps null, booleans and numbers (I8, I10)', async () => {
    const input = { a: undefined, b: null, c: true, d: 1.5, e: [null] };
    expect(await hashForm(input, true, 'messages')).toEqual({
      b: null,
      c: true,
      d: 1.5,
      e: [null],
    });
  });

  it('2.7 keeps an own __proto__ key as data (§12.2)', async () => {
    const input = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    const form = (await hashForm(input, true, 'messages')) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(form)).toBe(Object.prototype);
    expect(Object.keys(form)).toEqual(['__proto__']);
  });

  it('2.7 throws DissentArgumentError(invalid-option) for unsupported values (I4)', async () => {
    const foo = Object.create({ inherited: true }) as unknown;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad: unknown[] = [
      undefined,
      10n,
      () => 1,
      Symbol('s'),
      Number.NaN,
      Infinity,
      new Date(0),
      new Map(),
      foo,
      [1, undefined],
      cyclic,
    ];
    for (const value of bad) {
      const error = await hashForm(value, true, 'instructions').catch(
        (e: unknown) => e,
      );
      expect(DissentArgumentError.isInstance(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'invalid-option',
        argument: 'instructions',
      });
    }
  });

  it('2.7 does not mutate its input (I4)', async () => {
    const input = [{ role: 'user', content: 'a\r\nb' }];
    await hashForm(input, true, 'messages');
    expect(input).toEqual([{ role: 'user', content: 'a\r\nb' }]);
  });
});
