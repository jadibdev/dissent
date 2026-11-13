import { describe, expect, it } from 'vitest';

import {
  appendPointer,
  escapePointerToken,
  normalizePath,
  parsePointer,
  unescapePointerToken,
} from './paths.js';

describe('paths', () => {
  it('2.8 escape and unescape round trip (§5.1)', () => {
    for (const token of [
      '',
      'a',
      'a/b',
      't~x',
      '~0',
      '~1',
      '~/~',
      '//',
      '~~',
    ]) {
      expect(unescapePointerToken(escapePointerToken(token))).toBe(token);
    }
    expect(escapePointerToken('a/b')).toBe('a~1b');
    expect(escapePointerToken('t~x')).toBe('t~0x');
    expect(escapePointerToken('~1')).toBe('~01'); // ~ is escaped before /
  });

  it('2.8 an empty key is a valid token (§5.1)', () => {
    expect(appendPointer('', '')).toBe('/');
    expect(parsePointer('/')).toEqual(['']);
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a~1b/~0/')).toEqual(['a/b', '~', '']);
  });

  it('2.8 rejects malformed pointers and tokens (§5.1)', () => {
    expect(() => parsePointer('risk')).toThrow(SyntaxError);
    expect(() => unescapePointerToken('a~2')).toThrow(SyntaxError);
    expect(() => unescapePointerToken('a~')).toThrow(SyntaxError);
  });

  it('2.8 normalizes top-level names to pointers and keeps pointers (§5.1)', () => {
    expect(normalizePath('risk')).toBe('/risk');
    expect(normalizePath('/a~1b')).toBe('/a~1b');
    expect(normalizePath('/meta/owner')).toBe('/meta/owner');
    expect(normalizePath('a/b')).toBe('/a~1b'); // not "/"-prefixed: one property name
    expect(normalizePath('t~x')).toBe('/t~0x');
    expect(normalizePath('')).toBe('/');
  });
});
