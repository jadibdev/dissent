const ROOT_MARKER = Symbol.for('dissent.error.DissentError');
const ARGUMENT_MARKER = Symbol.for('dissent.error.DissentArgumentError');
const NON_JSON_MARKER = Symbol.for('dissent.error.NonJsonValueError');

function hasMarker(error: unknown, marker: symbol): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[marker] === true
  );
}

export class DissentError extends Error {
  readonly [ROOT_MARKER] = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DissentError';
  }

  static isInstance(error: unknown): error is DissentError {
    return hasMarker(error, ROOT_MARKER);
  }
}

export type DissentArgumentCode =
  | 'too-few-witnesses'
  | 'too-many-witnesses'
  | 'invalid-label'
  | 'reserved-label'
  | 'invalid-witness-entry'
  | 'prompt-and-messages'
  | 'no-input'
  | 'schema-root-not-object'
  | 'unknown-compare-path'
  | 'incompatible-override'
  | 'invalid-tolerance'
  | 'invalid-key'
  | 'invalid-author-model'
  | 'exclude-without-authors'
  | 'too-few-witnesses-after-exclusion'
  | 'invalid-option'
  | 'invalid-evidence';

export class DissentArgumentError extends DissentError {
  readonly [ARGUMENT_MARKER] = true;
  declare readonly name: 'DissentArgumentError';
  readonly code: DissentArgumentCode;
  /** The option or path at fault, e.g. 'witnesses.__proto__' or 'compare./risk'. */
  readonly argument: string;

  constructor(code: DissentArgumentCode, argument: string, message?: string) {
    super(message ?? `Invalid argument "${argument}": ${code}`);
    this.name = 'DissentArgumentError';
    this.code = code;
    this.argument = argument;
  }

  static override isInstance(error: unknown): error is DissentArgumentError {
    return hasMarker(error, ARGUMENT_MARKER);
  }
}

/** Thrown by the internal canonicalizer; caught in Layer A and recorded as invalid-output. */
export class NonJsonValueError extends DissentError {
  readonly [NON_JSON_MARKER] = true;
  declare readonly name: 'NonJsonValueError';
  /** JSON Pointer of the offending value. */
  readonly path: string;
  /** e.g. 'Date', 'Map', 'NaN', 'Infinity', 'bigint', 'function', 'symbol', 'undefined-in-array', 'cycle', 'depth'. */
  readonly found: string;

  constructor(path: string, found: string) {
    super(
      `Value at "${path === '' ? '(root)' : path}" is not JSON-compatible: ${found}`,
    );
    this.name = 'NonJsonValueError';
    this.path = path;
    this.found = found;
  }

  static override isInstance(error: unknown): error is NonJsonValueError {
    return hasMarker(error, NON_JSON_MARKER);
  }
}
