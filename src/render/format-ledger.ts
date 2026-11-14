import { isPlainObject } from '../compare/util.js';
import { DissentArgumentError } from '../errors.js';

import type { FormatLedgerOptions, Ledger } from '../types.js';

import { formatAscii } from './format-ascii.js';
import {
  formatMarkdown,
  type ResolvedRenderOptions,
} from './format-markdown.js';

const DEFAULT_MAX_INLINE_CHARS = 120;
const DEFAULT_MAX_BLOCK_CHARS = 4000;

function readPositiveIntOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DissentArgumentError('invalid-option', name);
  }
  return value;
}

/**
 * Renders a `Ledger` as Markdown or ASCII without reading the clock, environment, or network (§11).
 */
export function formatLedger(
  ledger: Ledger<unknown, string>,
  options?: FormatLedgerOptions,
): string {
  if (options !== undefined && !isPlainObject(options)) {
    throw new DissentArgumentError('invalid-option', 'options');
  }

  const format = options?.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'ascii') {
    throw new DissentArgumentError('invalid-option', 'format');
  }

  if (
    options?.showOutputs !== undefined &&
    typeof options.showOutputs !== 'boolean'
  ) {
    throw new DissentArgumentError('invalid-option', 'showOutputs');
  }

  const resolved: ResolvedRenderOptions = {
    maxInlineChars: readPositiveIntOption(
      options?.maxInlineChars,
      DEFAULT_MAX_INLINE_CHARS,
      'maxInlineChars',
    ),
    maxBlockChars: readPositiveIntOption(
      options?.maxBlockChars,
      DEFAULT_MAX_BLOCK_CHARS,
      'maxBlockChars',
    ),
    showOutputs: options?.showOutputs === true,
  };
  if (options?.adjudication !== undefined) {
    resolved.adjudication = options.adjudication;
  }

  return format === 'markdown'
    ? formatMarkdown(ledger, resolved)
    : formatAscii(ledger, resolved);
}
