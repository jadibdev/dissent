/** RFC 6901 JSON Pointer helpers (§5.1). Pure, no imports. */

export function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Throws `SyntaxError` for a `~` not followed by `0` or `1`. */
export function unescapePointerToken(token: string): string {
  if (/~(?![01])/.test(token)) {
    throw new SyntaxError(`Invalid JSON Pointer token: ${token}`);
  }
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Appends one escaped token to a pointer. `appendPointer('', 'a/b')` is `/a~1b`. */
export function appendPointer(pointer: string, token: string): string {
  return `${pointer}/${escapePointerToken(token)}`;
}

/** Splits a pointer into unescaped tokens. `''` is the root (no tokens). */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new SyntaxError(
      `JSON Pointer must be empty or start with "/": ${pointer}`,
    );
  }
  return pointer.slice(1).split('/').map(unescapePointerToken);
}

/**
 * Normalizes a `compare` key or `claim.path`: a string starting with `/` is already a
 * pointer; any other string is a top-level property name (§5.1).
 */
export function normalizePath(pathOrName: string): string {
  return pathOrName.startsWith('/')
    ? pathOrName
    : `/${escapePointerToken(pathOrName)}`;
}
