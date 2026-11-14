import { canonicalJson } from '../canonical/canonical-json.js';
import { readByPointer } from '../compare/compare-fields.js';
import { ownValue, sortLabels } from '../compare/util.js';
import { sanitizeControlChars, sanitizeInline } from '../sanitize.js';

import type {
  ExactResult,
  FieldResult,
  Finding,
  JSONValue,
  KeyedSetResult,
  LeafResult,
  Ledger,
  SetResult,
  ToleranceResult,
  UnionResult,
  WitnessRecord,
} from '../types.js';

const MARKDOWN_INLINE_SPECIAL_RE = /[\\`*_[\](){}#+\-.!|<>~]/g;

/** Counts the longest consecutive run of backticks in `text`. */
export function longestBacktickRun(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > max) max = match[0].length;
  }
  return max;
}

function collapseInline(text: string, maxInlineChars: number): string {
  const clean = sanitizeInline(text);
  const cps = Array.from(clean);
  if (cps.length <= maxInlineChars) return clean;
  if (maxInlineChars <= 1) return maxInlineChars === 1 ? '…' : '';
  return `${cps.slice(0, maxInlineChars - 1).join('')}…`;
}

/**
 * Escapes untrusted text for Markdown inline contexts (§11.3 steps 1–3):
 * sanitize → inline collapse/truncate → backslash-escape punctuation → `&amp;` / `&#64;`.
 */
export function escapeMarkdownInline(
  text: string,
  maxInlineChars: number,
): string {
  const collapsed = collapseInline(text, maxInlineChars);
  return collapsed
    .replace(MARKDOWN_INLINE_SPECIAL_RE, '\\$&')
    .replaceAll('&', '&amp;')
    .replaceAll('@', '&#64;');
}

/** Sanitizes and truncates untrusted text for ASCII inline lines (§11.3 steps 1–2). */
export function escapeAsciiInline(
  text: string,
  maxInlineChars: number,
): string {
  return collapseInline(text, maxInlineChars);
}

/** Renders a JSON value as an inline Markdown code span safe inside GFM tables (§11.3 step 4). */
export function formatMarkdownValue(
  value: JSONValue,
  maxInlineChars: number,
): string {
  const body = collapseInline(canonicalJson(value), maxInlineChars);
  const fence = '`'.repeat(longestBacktickRun(body) + 1);
  const padded =
    body.startsWith('`') || body.endsWith('`') ? ` ${body} ` : body;
  return `${fence}${padded.replaceAll('|', '\\|')}${fence}`;
}

/** Renders a JSON value for inline ASCII lines (§11.3 step 6). */
export function formatAsciiValue(
  value: JSONValue,
  maxInlineChars: number,
): string {
  return collapseInline(canonicalJson(value), maxInlineChars);
}

function truncateBlock(text: string, maxBlockChars: number): string {
  const clean = sanitizeControlChars(text);
  const cps = Array.from(clean);
  if (cps.length <= maxBlockChars) return clean;
  const remaining = cps.length - maxBlockChars;
  return `${cps.slice(0, maxBlockChars).join('')}\n… (truncated, ${remaining} more characters)`;
}

/** Renders an untrusted block inside a safe Markdown code fence with no info string (§11.3 step 5). */
export function formatMarkdownBlock(
  text: string,
  maxBlockChars: number,
): string {
  const body = truncateBlock(text, maxBlockChars);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}\n${body}\n${fence}`;
}

/** Renders an untrusted block indented by four spaces per line for ASCII (§11.3 step 6). */
export function formatAsciiBlock(text: string, maxBlockChars: number): string {
  const body = truncateBlock(text, maxBlockChars);
  return body
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
}

export type InlineRenderers = {
  inline: (text: string) => string;
  value: (val: JSONValue) => string;
};

/** Formats the mandatory summary line (§11.1 item 2). */
export function formatSummaryLine(ledger: Ledger<unknown, string>): string {
  const { quorum: q, coverage: c } = ledger;
  const pct = Math.round(c.ratio * 100);
  return (
    `Advisory: ${sanitizeInline(ledger.advisory)} · ` +
    `Quorum: ${q.answered}/${q.listed} answered (${q.failed} failed, ${q.excluded} excluded) · ` +
    `Coverage: compared ${c.compared} of ${c.fields} fields (${pct}%)`
  );
}

/** Formats the detail/error/stage column for a witness record (§11.1 item 3). */
export function formatWitnessDetail(
  rec: WitnessRecord<unknown>,
  escInline: (text: string) => string,
): string {
  if (rec.status === 'failed') {
    return `${sanitizeInline(rec.error.kind)}: ${escInline(rec.error.message)}`;
  }
  if (rec.status === 'excluded') {
    return `${sanitizeInline(rec.stage)} (${sanitizeInline(rec.match.on)}=${escInline(rec.match.authorModel)})`;
  }
  return rec.finishReason === 'length' ? 'finish: length' : '—';
}

/**
 * Recovers raw non-array, non-null present values from answering witnesses when a `set`
 * or `keyed-set` field splits due to a scalar/object value (Handoff §0 P3-6).
 */
export function findNonArrayRawValues<W extends string>(
  ledger: Ledger<unknown, W>,
  path: string,
  res: SetResult<W> | KeyedSetResult<W>,
): Array<{ witness: W; value: JSONValue }> {
  const nullSet = new Set<W>(res.nulls);
  const extras: Array<{ witness: W; value: JSONValue }> = [];
  for (const w of res.presented) {
    if (nullSet.has(w)) continue;
    const rec = ownValue<WitnessRecord<unknown>>(ledger.witnesses, w);
    if (rec?.status !== 'answered') continue;
    const read = readByPointer(rec.output as JSONValue, path);
    if (read.present && !Array.isArray(read.value) && read.value !== null) {
      extras.push({ witness: w, value: read.value });
    }
  }
  return extras;
}

function summarizeExact<W extends string>(
  res: ExactResult<W>,
  r: InlineRenderers,
): string {
  const parts = res.groups.map(
    g => `${r.value(g.value)} (${g.support}/${res.answered})`,
  );
  const body = parts.length > 0 ? parts.join(', ') : '—';
  if (res.missing.length > 0) {
    return `${body} · missing: ${res.missing.map(r.inline).join(', ')}`;
  }
  return body;
}

function summarizeTolerance<W extends string>(
  res: ToleranceResult<W>,
  r: InlineRenderers,
): string {
  const parts: string[] = [];
  if (
    res.min !== undefined &&
    res.max !== undefined &&
    res.spread !== undefined
  ) {
    const cleanSpread = Number(res.spread.toPrecision(12));
    parts.push(`${res.min}–${res.max} (spread ${cleanSpread})`);
  }
  const groupText = res.groups.map(g => {
    const label = g.min === g.max ? String(g.min) : `${g.min}–${g.max}`;
    return `${label} (${g.support}/${res.answered})`;
  });
  if (res.nullGroup !== undefined) {
    groupText.push(`null (${res.nullGroup.support}/${res.answered})`);
  }
  if (groupText.length > 0) {
    parts.push(groupText.join(', '));
  }
  if (res.missing.length > 0) {
    parts.push(`missing: ${res.missing.map(r.inline).join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function summarizeSet<W extends string>(
  ledger: Ledger<unknown, W>,
  path: string | null,
  res: SetResult<W>,
  r: InlineRenderers,
): string {
  const head = [
    `∩ ${res.intersection.length}`,
    `∪ ${res.union.length}`,
    ...(res.jaccard !== undefined ? [`J=${res.jaccard.toFixed(2)}`] : []),
  ].join(' · ');

  const interKeys = new Set(res.intersection.map(v => canonicalJson(v)));
  const nonInter = res.items
    .filter(item => !interKeys.has(canonicalJson(item.item)))
    .map(item => `${r.value(item.item)} (${item.support}/${res.answered})`);

  let text = nonInter.length > 0 ? `${head}: ${nonInter.join(', ')}` : head;
  if (res.nulls.length > 0) {
    text += ` · nulls: ${res.nulls.map(r.inline).join(', ')}`;
  }
  const nonArrays =
    path !== null ? findNonArrayRawValues(ledger, path, res) : [];
  if (nonArrays.length > 0) {
    text += ` · non-array: ${nonArrays.map(e => `${r.inline(e.witness)}=${r.value(e.value)}`).join(', ')}`;
  }
  if (res.missing.length > 0) {
    text += ` · missing: ${res.missing.map(r.inline).join(', ')}`;
  }
  return text;
}

/** Formats a leaf field result concisely (§11.1 item 4). */
export function summarizeLeafResult<W extends string>(
  ledger: Ledger<unknown, W>,
  path: string | null,
  res: LeafResult<W>,
  r: InlineRenderers,
): string {
  switch (res.comparator) {
    case 'exact':
      return summarizeExact(res, r);
    case 'tolerance':
      return summarizeTolerance(res, r);
    case 'set':
      return summarizeSet(ledger, path, res, r);
    case 'none': {
      let text = `${r.inline(res.reason)}/${r.inline(res.detail)}`;
      if (
        res.duplicateKeyWitnesses !== undefined &&
        res.duplicateKeyWitnesses.length > 0
      ) {
        text += ` (${res.duplicateKeyWitnesses.map(r.inline).join(', ')})`;
      } else if (
        !(res.reason === 'policy' && res.detail === 'free-text') &&
        res.values.length > 0
      ) {
        text += `: ${res.values.map(v => `${r.inline(v.witness)}=${r.value(v.value)}`).join(', ')}`;
      }
      return text;
    }
  }
}

/** Formats any top-level `FieldResult` summary line (§11.1 item 4). */
export function summarizeFieldResult<W extends string>(
  ledger: Ledger<unknown, W>,
  path: string,
  res: FieldResult<W>,
  r: InlineRenderers,
): string {
  if (res.comparator === 'keyed-set') {
    const head = [
      `key=${r.inline(res.key)}`,
      `∩ ${res.keys.intersection.length}`,
      `∪ ${res.keys.union.length}`,
      ...(res.keys.jaccard !== undefined
        ? [`J=${res.keys.jaccard.toFixed(2)}`]
        : []),
    ].join(' · ');
    const nonArrays = findNonArrayRawValues(ledger, path, res);
    if (nonArrays.length > 0) {
      return `${head} · non-array: ${nonArrays.map(e => `${r.inline(e.witness)}=${r.value(e.value)}`).join(', ')}`;
    }
    return head;
  }
  if (res.comparator === 'discriminated-union') {
    return `by ${r.inline(res.discriminator)}: ${summarizeExact(res.choice, r)}`;
  }
  return summarizeLeafResult(ledger, path, res, r);
}

/** Builds structured sub-rows for `keyed-set` and `discriminated-union` fields (§11.1 item 4). */
export function buildCompositeSubRows<W extends string>(
  ledger: Ledger<unknown, W>,
  path: string,
  res: KeyedSetResult<W> | UnionResult<W>,
  r: InlineRenderers,
): Array<{
  heading: string;
  leaves: Array<{ subpath: string; summary: string }>;
}> {
  const entries =
    res.comparator === 'keyed-set'
      ? res.items.map(item => ({
          heading: `key=${r.value(item.key)} (${item.witnesses.map(r.inline).join(', ')})`,
          fields: item.fields,
        }))
      : res.branches.map(branch => ({
          heading: `branch=${r.value(branch.value)} (${branch.witnesses.map(r.inline).join(', ')})`,
          fields: branch.fields,
        }));

  return entries.map(entry => ({
    heading: entry.heading,
    leaves: sortLabels(Object.keys(entry.fields)).map(subpath => ({
      subpath: r.inline(subpath),
      summary: summarizeLeafResult(
        ledger,
        res.comparator === 'discriminated-union' ? `${path}${subpath}` : null,
        ownValue<LeafResult<W>>(entry.fields, subpath)!,
        r,
      ),
    })),
  }));
}

/** Extracts non-empty Independence display rows (§11.1 item 6). */
export function buildIndependenceEntries<W extends string>(
  ind: Ledger<unknown, W>['independence'],
  escInline: (text: string) => string,
): Array<{ label: string; value: string }> {
  const entries: Array<{ label: string; value: string }> = [];
  if (ind.uniqueRequestedProviders > 0) {
    entries.push({
      label: 'Unique requested providers',
      value: String(ind.uniqueRequestedProviders),
    });
  }
  if (ind.duplicateServedModels.length > 0) {
    entries.push({
      label: 'Duplicate served models',
      value: ind.duplicateServedModels
        .map(
          d =>
            `${escInline(d.canonicalId)} (${d.witnesses.map(escInline).join(', ')})`,
        )
        .join('; '),
    });
  }
  if (ind.sameProviderGroups.length > 0) {
    entries.push({
      label: 'Same-provider groups',
      value: ind.sameProviderGroups
        .map(
          g =>
            `${escInline(g.providerKey)} (${g.witnesses.map(escInline).join(', ')})`,
        )
        .join('; '),
    });
  }
  if (ind.selfGradingWitnesses.length > 0) {
    entries.push({
      label: 'Self-grading witnesses',
      value: ind.selfGradingWitnesses
        .map(
          s =>
            `${escInline(s.witness)} (${sanitizeInline(s.on)}=${escInline(s.authorModel)})`,
        )
        .join('; '),
    });
  }
  if (ind.excludedWitnesses.length > 0) {
    entries.push({
      label: 'Excluded witnesses',
      value: ind.excludedWitnesses
        .map(
          e =>
            `${escInline(e.witness)} (${sanitizeInline(e.stage)}, ${sanitizeInline(e.on)}=${escInline(e.authorModel)})`,
        )
        .join('; '),
    });
  }
  return entries;
}

/** Formats a finding's target (`path` / `within` / `subpath`) safely (§11.1 item 5). */
export function formatFindingTarget<W extends string>(
  finding: Finding<W>,
  r: InlineRenderers,
): string {
  if (finding.path === undefined) return '—';
  let target = r.inline(finding.path);
  if (finding.within !== undefined) {
    target +=
      'key' in finding.within
        ? ` [key=${r.value(finding.within.key)}]`
        : ` [branch=${r.value(finding.within.branch)}]`;
  }
  if (finding.subpath !== undefined) {
    target += ` ${r.inline(finding.subpath)}`;
  }
  return target;
}
