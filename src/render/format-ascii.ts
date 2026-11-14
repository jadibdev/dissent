import { canonicalJson } from '../canonical/canonical-json.js';
import { ownValue, sortLabels } from '../compare/util.js';
import { sanitizeInline } from '../sanitize.js';

import type {
  FieldResult,
  Ledger,
  NotComparedResult,
  WitnessRecord,
} from '../types.js';

import {
  buildCompositeSubRows,
  buildIndependenceEntries,
  escapeAsciiInline,
  formatAsciiBlock,
  formatAsciiValue,
  formatFindingTarget,
  formatSummaryLine,
  formatWitnessDetail,
  summarizeFieldResult,
  type InlineRenderers,
} from './escape.js';
import type { ResolvedRenderOptions } from './format-markdown.js';

const RULE_MAJOR = '='.repeat(78);
const RULE_MINOR = '-'.repeat(78);

/** Renders a Ledger (and optional Adjudication) as an ASCII cockpit report (§11.1–§11.3). */
export function formatAscii(
  ledger: Ledger<unknown, string>,
  options: ResolvedRenderOptions,
): string {
  const { maxInlineChars, maxBlockChars, adjudication, showOutputs } = options;
  const esc = (text: string): string => escapeAsciiInline(text, maxInlineChars);
  const fmtVal = (val: Parameters<typeof formatAsciiValue>[0]): string =>
    formatAsciiValue(val, maxInlineChars);
  const renderers: InlineRenderers = { inline: esc, value: fmtVal };

  const cleanFp = sanitizeInline(ledger.fingerprint);
  const shortFp = cleanFp.length > 12 ? `${cleanFp.slice(0, 12)}…` : cleanFp;

  const lines: string[] = [];

  // 1. Header
  lines.push(RULE_MAJOR);
  lines.push('Dissent Ledger');
  lines.push(RULE_MAJOR);
  lines.push(`Protocol    : ${sanitizeInline(ledger.protocol)}`);
  lines.push(`Fingerprint : ${shortFp}`);
  lines.push(`Created     : ${sanitizeInline(ledger.createdAt)}`);
  lines.push('');

  // 2. Summary line
  lines.push(formatSummaryLine(ledger), '');

  // 3. Witnesses
  lines.push('Witnesses', RULE_MINOR);
  const witnessLabels = sortLabels(Object.keys(ledger.witnesses));
  for (const label of witnessLabels) {
    const rec = ownValue<WitnessRecord<unknown>>(ledger.witnesses, label)!;
    const req = esc(rec.requested.canonicalId);
    const served = rec.served !== null ? esc(rec.served.canonicalId) : '—';
    const detail = formatWitnessDetail(rec, esc);
    const tokens =
      rec.usage?.totalTokens !== null && rec.usage?.totalTokens !== undefined
        ? String(rec.usage.totalTokens)
        : '—';
    lines.push(
      `${esc(label)} : status=${sanitizeInline(rec.status)}, req=${req}, served=${served}, detail=${detail}, duration=${rec.durationMs}ms, tokens=${tokens}`,
    );
  }
  lines.push('');

  // 4. Fields
  lines.push('Fields', RULE_MINOR);
  const fieldPaths = sortLabels(Object.keys(ledger.fields));
  const freeTextFields: Array<{
    path: string;
    result: NotComparedResult<string>;
  }> = [];

  if (fieldPaths.length === 0) {
    lines.push('No fields.');
  } else {
    for (const path of fieldPaths) {
      const res = ownValue<FieldResult<string>>(ledger.fields, path)!;
      const summary = summarizeFieldResult(ledger, path, res, renderers);
      lines.push(
        `${esc(path)} : ${sanitizeInline(res.comparator)} [${sanitizeInline(res.status)}] -- ${summary}`,
      );
      if (
        res.comparator === 'keyed-set' ||
        res.comparator === 'discriminated-union'
      ) {
        for (const sub of buildCompositeSubRows(ledger, path, res, renderers)) {
          lines.push(`  ${sub.heading}`);
          for (const leaf of sub.leaves) {
            lines.push(`    ${leaf.subpath} : ${leaf.summary}`);
          }
        }
      } else if (
        res.comparator === 'none' &&
        res.reason === 'policy' &&
        res.detail === 'free-text' &&
        res.values.length > 0
      ) {
        freeTextFields.push({ path, result: res });
      }
    }
  }
  lines.push('');

  if (freeTextFields.length > 0) {
    lines.push('Read side by side', RULE_MINOR);
    for (const entry of freeTextFields) {
      for (const item of entry.result.values) {
        lines.push(`${esc(entry.path)} (${esc(item.witness)}) :`);
        const text =
          typeof item.value === 'string'
            ? item.value
            : canonicalJson(item.value);
        lines.push(formatAsciiBlock(text, maxBlockChars));
      }
    }
    lines.push('');
  }

  // 5. Findings
  lines.push('Findings', RULE_MINOR);
  if (ledger.findings.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of ledger.findings) {
      const target = formatFindingTarget(finding, renderers);
      const witnesses =
        finding.witnesses !== undefined && finding.witnesses.length > 0
          ? finding.witnesses.map(esc).join(', ')
          : '—';
      lines.push(
        `${sanitizeInline(finding.severity)} : ${sanitizeInline(finding.code)}, target=${target}, witnesses=${witnesses}`,
      );
    }
  }
  lines.push('');

  // 6. Independence (only non-empty parts)
  const indEntries = buildIndependenceEntries(ledger.independence, esc);
  if (indEntries.length > 0) {
    lines.push('Independence', RULE_MINOR);
    for (const entry of indEntries) {
      lines.push(`${entry.label} : ${entry.value}`);
    }
    lines.push('');
  }

  // 7. Adjudication (if given)
  if (adjudication !== undefined) {
    const ae = adjudication.artifactEvidence;
    lines.push('Adjudication', RULE_MINOR);
    lines.push(
      `Verdict           : ${sanitizeInline(adjudication.verdict)} (${sanitizeInline(adjudication.verdictReason)})`,
    );
    lines.push(
      `Artifact evidence : pass=${ae.pass}, fail=${ae.fail}, error=${ae.error}, unknown=${ae.unknown}`,
    );
    lines.push(`Unbound           : ${adjudication.unbound.length}`);
    lines.push(`Conflicts         : ${adjudication.conflicts.length}`);

    for (const s of adjudication.settlements) {
      const agree =
        s.witnessesAgreeing.length > 0
          ? s.witnessesAgreeing.map(esc).join(', ')
          : '—';
      const dissent =
        s.witnessesDissenting.length > 0
          ? s.witnessesDissenting.map(esc).join(', ')
          : '—';
      const silent =
        s.witnessesSilent.length > 0
          ? s.witnessesSilent.map(esc).join(', ')
          : '—';
      lines.push(
        `  ${esc(s.path)} : value=${fmtVal(s.value)}, source=${esc(s.source)}, outcome=${sanitizeInline(s.outcome)}, agree=[${agree}], dissent=[${dissent}], silent=[${silent}]`,
      );
    }

    for (const c of adjudication.conflicts) {
      lines.push(
        `  conflict ${esc(c.path)} : ${c.sources.map(esc).join(', ')}`,
      );
    }

    for (const rc of adjudication.receiptChecks) {
      const status = rc.check.valid
        ? 'valid'
        : `invalid (${sanitizeInline(rc.check.reason)})`;
      const rid = rc.receiptId !== null ? esc(rc.receiptId) : '—';
      lines.push(`  receipt ${esc(rc.source)} : id=${rid}, ${status}`);
    }
    lines.push('');
  }

  // 8. Outputs (only with showOutputs)
  if (showOutputs) {
    lines.push('Outputs', RULE_MINOR);
    for (const label of witnessLabels) {
      const rec = ownValue<WitnessRecord<unknown>>(ledger.witnesses, label)!;
      if (rec.status !== 'answered') continue;
      lines.push(`${esc(label)} :`);
      const jsonText = JSON.stringify(rec.output, null, 2) ?? 'null';
      lines.push(formatAsciiBlock(jsonText, maxBlockChars));
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
