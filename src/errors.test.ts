import { describe, expect, it } from 'vitest';

import {
  DissentArgumentError,
  DissentError,
  NonJsonValueError,
} from './errors.js';

describe('errors', () => {
  it('2.9 isInstance recognizes own classes and the inheritance chain (§2.10)', () => {
    const argument = new DissentArgumentError('invalid-option', 'prompt');
    const nonJson = new NonJsonValueError('/a', 'Date');
    expect(DissentError.isInstance(argument)).toBe(true);
    expect(DissentError.isInstance(nonJson)).toBe(true);
    expect(DissentArgumentError.isInstance(argument)).toBe(true);
    expect(NonJsonValueError.isInstance(nonJson)).toBe(true);
    expect(DissentArgumentError.isInstance(nonJson)).toBe(false);
    expect(NonJsonValueError.isInstance(argument)).toBe(false);
    expect(argument).toBeInstanceOf(Error);
    expect(argument.name).toBe('DissentArgumentError');
    expect(nonJson.name).toBe('NonJsonValueError');
  });

  it('2.9 isInstance works across two module copies via Symbol.for markers (§2.10)', () => {
    // A second copy of the package defines fresh classes carrying the same registry symbols.
    class OtherCopyError extends Error {}
    const foreign = Object.assign(new OtherCopyError('x'), {
      [Symbol.for('dissent.error.DissentError')]: true,
      [Symbol.for('dissent.error.DissentArgumentError')]: true,
    });
    expect(foreign instanceof DissentError).toBe(false);
    expect(DissentError.isInstance(foreign)).toBe(true);
    expect(DissentArgumentError.isInstance(foreign)).toBe(true);
    expect(NonJsonValueError.isInstance(foreign)).toBe(false);
  });

  it('2.9 isInstance rejects look-alikes (§2.10)', () => {
    for (const value of [
      null,
      undefined,
      'x',
      1,
      {},
      new Error('x'),
      { name: 'DissentError' },
    ]) {
      expect(DissentError.isInstance(value)).toBe(false);
    }
  });

  it('2.9 carries code, argument, path and found (§2.10)', () => {
    const argument = new DissentArgumentError(
      'reserved-label',
      'witnesses.constructor',
    );
    expect(argument).toMatchObject({
      code: 'reserved-label',
      argument: 'witnesses.constructor',
    });
    const nonJson = new NonJsonValueError('/a~1b/0', 'NaN');
    expect(nonJson).toMatchObject({ path: '/a~1b/0', found: 'NaN' });
    expect(nonJson.message).toContain('/a~1b/0');
  });
});
