import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sha256Hex, sha256HexBytes } from './sha256.js';

describe('sha256Hex', () => {
  it('2.6 matches the known vectors (I16)', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('2.6 hashes raw bytes the same as the equivalent UTF-8 text (I16)', async () => {
    expect(await sha256HexBytes(new TextEncoder().encode('abc'))).toBe(
      await sha256Hex('abc'),
    );
  });

  it('2.6 encodes text as UTF-8 (I16)', async () => {
    expect(await sha256Hex('é')).toBe(
      await sha256HexBytes(new Uint8Array([0xc3, 0xa9])),
    );
  });

  it('2.6 does not import node:crypto or any other module (I16)', () => {
    const source = readFileSync(
      new URL('./sha256.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});
