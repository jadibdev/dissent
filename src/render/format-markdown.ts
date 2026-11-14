import { canonicalJson } from '../canonical/canonical-json.js';
import { ownValue, sortLabels } from '../compare/util.js';
import { sanitizeInline } from '../sanitize.js';

import type {
  Adjudication,
  FieldResult,
  Ledger,
  NotComparedResult,
  WitnessRecord,
} from '../types.js';

import {
  buildCompositeSubRows,
  buildIndependenceEntries,
  escapeMarkdownInline,
  formatFindingTarget,
  formatMarkdownBlock,
  formatMarkdownValue,
  formatSummaryLine,
  formatWitnessDetail,
  summarizeFieldResult,
  type InlineRenderers,
} from './escape.js';

export type ResolvedRenderOptions = {
  adjudication?: Adjudication;
  maxInlineChars: number;
  maxBlockChars: number;
  showOutputs: boolean;
};

/** Renders a Ledger (and optional Adjudication) as GitHub-Flavored Markdown (§11.1–§11.3). */
export function formatMarkdown(
  ledger: Ledger<unknown, string>,
  options: ResolvedRenderOptions,
): string {
  const { maxInlineChars, maxBlockChars, adjudication, showOutputs } = options;
  const esc = (text: string): string =>
    escapeMarkdownInline(text, maxInlineChars);
  const fmtVal = (val: Parameters<typeof formatMarkdownValue>[0]): string =>
    formatMarkdownValue(val, maxInlineChars);
  const renderers: InlineRenderers = { inline: esc, value: fmtVal };

  const lines: string[] = [];

  // 1. Header
  lines.push('## Dissent Ledger', '');
  lines.push(`- **Protocol:** ${sanitizeInline(ledger.protocol)}`);
  lines.push(`- **Fingerprint:** ${sanitizeInline(ledger.fingerprint)}`);
  lines.push(`- **Created:** ${sanitizeInline(ledger.createdAt)}`);
  lines.push('');

  // 2. Summary line
  lines.push(formatSummaryLine(ledger), '');

  // 3. Witnesses
  lines.push('### Witnesses', '');
  lines.push(
    '| Label | Requested | Served | Status | Detail | Duration | Tokens |',
  );
  lines.push('|---|---|---|---|---|---:|---:|');
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
      `| ${esc(label)} | ${req} | ${served} | ${sanitizeInline(rec.status)} | ${detail} | ${rec.durationMs}ms | ${tokens} |`,
    );
  }
  lines.push('');

  // 4. Fields
  lines.push('### Fields', '');
  const fieldPaths = sortLabels(Object.keys(ledger.fields));
  const compositeDetails: Array<{
    path: string;
    subRows: ReturnType<typeof buildCompositeSubRows>;
  }> = [];
  const freeTextFields: Array<{
    path: string;
    result: NotComparedResult<string>;
  }> = [];

  if (fieldPaths.length === 0) {
    lines.push('No fields.', '');
  } else {
    lines.push('| Path | Comparator | Status | Summary |');
    lines.push('|---|---|---|---|');
    for (const path of fieldPaths) {
      const res = ownValue<FieldResult<string>>(ledger.fields, path)!;
      const summary = summarizeFieldResult(ledger, path, res, renderers);
      lines.push(
        `| ${esc(path)} | ${sanitizeInline(res.comparator)} | ${sanitizeInline(res.status)} | ${summary} |`,
      );
      if (
        res.comparator === 'keyed-set' ||
        res.comparator === 'discriminated-union'
      ) {
        compositeDetails.push({
          path,
          subRows: buildCompositeSubRows(ledger, path, res, renderers),
        });
      } else if (
        res.comparator === 'none' &&
        res.reason === 'policy' &&
        res.detail === 'free-text' &&
        res.values.length > 0
      ) {
        freeTextFields.push({ path, result: res });
      }
    }
    lines.push('');
  }

  for (const detail of compositeDetails) {
    if (detail.subRows.length === 0) continue;
    lines.push(`#### ${esc(detail.path)}`, '');
    for (const sub of detail.subRows) {
      lines.push(`- ${sub.heading}`);
      for (const leaf of sub.leaves) {
        lines.push(`  - ${leaf.subpath}: ${leaf.summary}`);
      }
    }
    lines.push('');
  }

  if (freeTextFields.length > 0) {
    lines.push('### Read side by side', '');
    for (const entry of freeTextFields) {
      for (const item of entry.result.values) {
        lines.push(`- **${esc(entry.path)} — ${esc(item.witness)}:**`, '');
        const text =
          typeof item.value === 'string'
            ? item.value
            : canonicalJson(item.value);
        lines.push(formatMarkdownBlock(text, maxBlockChars), '');
      }
    }
  }

  // 5. Findings
  lines.push('### Findings', '');
  if (ledger.findings.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Severity | Code | Target | Witnesses |');
    lines.push('|---|---|---|---|');
    for (const finding of ledger.findings) {
      const target = formatFindingTarget(finding, renderers);
      const witnesses =
        finding.witnesses !== undefined && finding.witnesses.length > 0
          ? finding.witnesses.map(esc).join(', ')
          : '—';
      lines.push(
        `| ${sanitizeInline(finding.severity)} | ${sanitizeInline(finding.code)} | ${target} | ${witnesses} |`,
      );
    }
    lines.push('');
  }

  // 6. Independence (only non-empty parts)
  const indEntries = buildIndependenceEntries(ledger.independence, esc);
  if (indEntries.length > 0) {
    lines.push('### Independence', '');
    for (const entry of indEntries) {
      lines.push(`- **${entry.label}:** ${entry.value}`);
    }
    lines.push('');
  }

  // 7. Adjudication (if given)
  if (adjudication !== undefined) {
    const ae = adjudication.artifactEvidence;
    lines.push('### Adjudication', '');
    lines.push(
      `- **Verdict:** ${sanitizeInline(adjudication.verdict)} (${sanitizeInline(adjudication.verdictReason)})`,
    );
    lines.push(
      `- **Artifact evidence:** pass=${ae.pass}, fail=${ae.fail}, error=${ae.error}, unknown=${ae.unknown}`,
    );
    lines.push(`- **Unbound:** ${adjudication.unbound.length}`);
    lines.push(`- **Conflicts:** ${adjudication.conflicts.length}`);
    lines.push('');

    if (adjudication.settlements.length > 0) {
      lines.push(
        '| Path | Value | Source | Outcome | Agreeing | Dissenting | Silent |',
      );
      lines.push('|---|---|---|---|---|---|---|');
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
          `| ${esc(s.path)} | ${fmtVal(s.value)} | ${esc(s.source)} | ${sanitizeInline(s.outcome)} | ${agree} | ${dissent} | ${silent} |`,
        );
      }
      lines.push('');
    }

    if (adjudication.conflicts.length > 0) {
      for (const c of adjudication.conflicts) {
        lines.push(
          `- **Conflict** ${esc(c.path)}: ${c.sources.map(esc).join(', ')}`,
        );
      }
      lines.push('');
    }

    if (adjudication.receiptChecks.length > 0) {
      lines.push('| Source | Receipt ID | Check |');
      lines.push('|---|---|---|');
      for (const rc of adjudication.receiptChecks) {
        const status = rc.check.valid
          ? 'valid'
          : `invalid (${sanitizeInline(rc.check.reason)})`;
        const rid = rc.receiptId !== null ? esc(rc.receiptId) : '—';
        lines.push(`| ${esc(rc.source)} | ${rid} | ${status} |`);
      }
      lines.push('');
    }
  }

  // 8. Outputs (only with showOutputs)
  if (showOutputs) {
    lines.push('### Outputs', '');
    for (const label of witnessLabels) {
      const rec = ownValue<WitnessRecord<unknown>>(ledger.witnesses, label)!;
      if (rec.status !== 'answered') continue;
      lines.push(`- **${esc(label)}:**`, '');
      const jsonText = JSON.stringify(rec.output, null, 2) ?? 'null';
      lines.push(formatMarkdownBlock(jsonText, maxBlockChars), '');
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
