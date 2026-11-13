import { canonicalJson, compareUtf16 } from './canonical/canonical-json.js';
import { ownValue, sortWith } from './compare/util.js';

import type {
  Advisory,
  Coverage,
  FieldPlan,
  FieldResult,
  Finding,
  JSONValue,
  LeafPlan,
  Severity,
} from './types.js';

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

function compareOptionalString(
  a: string | undefined,
  b: string | undefined,
): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return compareUtf16(a, b);
}

/**
 * Compares two findings according to §9.1 canonical order:
 * severity (critical < warn < info), code, path (absent first),
 * canonicalJson(within ?? null), subpath (absent first), witnesses[0] (absent first).
 */
export function compareFindings<W extends string>(
  a: Finding<W>,
  b: Finding<W>,
): number {
  const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sevDiff !== 0) return sevDiff;

  const codeDiff = compareUtf16(a.code, b.code);
  if (codeDiff !== 0) return codeDiff;

  const pathDiff = compareOptionalString(a.path, b.path);
  if (pathDiff !== 0) return pathDiff;

  const withinDiff = compareUtf16(
    canonicalJson(a.within ?? null),
    canonicalJson(b.within ?? null),
  );
  if (withinDiff !== 0) return withinDiff;

  const subpathDiff = compareOptionalString(a.subpath, b.subpath);
  if (subpathDiff !== 0) return subpathDiff;

  return compareOptionalString(a.witnesses?.[0], b.witnesses?.[0]);
}

/**
 * Returns a fresh array of findings sorted in canonical order (§9.1).
 */
export function sortFindings<W extends string>(
  findings: ReadonlyArray<Finding<W>>,
): Finding<W>[] {
  return sortWith(findings, compareFindings);
}

/**
 * Derives the three-state advisory rollup from findings (§9.2).
 */
export function computeAdvisory<W extends string>(
  findings: ReadonlyArray<Finding<W>>,
): Advisory {
  let hasWarn = false;
  for (const f of findings) {
    if (f.severity === 'critical') return 'review-required';
    if (f.severity === 'warn') hasWarn = true;
  }
  return hasWarn ? 'warnings' : 'clear';
}

export type CollectComparisonFindingsParams<W extends string> = {
  answered: number;
  planFields: Record<string, FieldPlan>;
  fieldResults: Record<string, FieldResult<W>>;
  coverage: Coverage;
  strictCoverage?: boolean;
};

function pushNestedLeafFindings<W extends string>(
  findings: Finding<W>[],
  opts: {
    path: string;
    within: { key: JSONValue } | { branch: JSONValue };
    planMap: Record<string, LeafPlan>;
    fieldMap: Record<string, FieldResult<W>>;
  },
): boolean {
  let anySplit = false;
  for (const subpath of Object.keys(opts.planMap)) {
    const subplan = ownValue<LeafPlan>(opts.planMap, subpath)!;
    const subres = ownValue<FieldResult<W>>(opts.fieldMap, subpath);
    if (subres === undefined) continue;

    if (subres.missing.length > 0 && subres.presented.length >= 1) {
      findings.push({
        code: 'field-partial',
        severity: 'warn',
        path: opts.path,
        within: opts.within,
        subpath,
        witnesses: [...subres.missing],
      });
    }
    if (subres.status === 'split' && subplan.comparator !== 'none') {
      anySplit = true;
      findings.push({
        code: 'field-split',
        severity: subplan.onSplit,
        path: opts.path,
        within: opts.within,
        subpath,
        witnesses: [...subres.presented],
      });
    }
  }
  return anySplit;
}

/**
 * Collects pure Layer B, schema, and coverage findings from comparison outputs.
 * When `answered < 2`, `insufficient-quorum` is emitted and field-level findings
 * (`field-split`, `field-partial`, `duplicate-key`) are suppressed while
 * `unsupported-schema` and `coverage-low` continue to be emitted (§9.1).
 */
export function collectComparisonFindings<W extends string>(
  params: CollectComparisonFindingsParams<W>,
): Finding<W>[] {
  const {
    answered,
    planFields,
    fieldResults,
    coverage,
    strictCoverage = false,
  } = params;

  const findings: Finding<W>[] = [];

  if (answered < 2) {
    findings.push({
      code: 'insufficient-quorum',
      severity: 'critical',
      data: { answered },
    });
  }

  for (const path of Object.keys(planFields)) {
    const plan = ownValue<FieldPlan>(planFields, path)!;
    const res = ownValue<FieldResult<W>>(fieldResults, path);

    // Schema findings (unsupported-schema) are emitted regardless of quorum.
    if (plan.comparator === 'none' && plan.reason === 'unsupported') {
      findings.push({
        code: 'unsupported-schema',
        severity: 'warn',
        path,
        data: { detail: plan.detail },
      });
    } else if (plan.comparator === 'keyed-set') {
      for (const subpath of Object.keys(plan.itemFields)) {
        const subplan = ownValue<LeafPlan>(plan.itemFields, subpath)!;
        if (subplan.comparator === 'none' && subplan.reason === 'unsupported') {
          findings.push({
            code: 'unsupported-schema',
            severity: 'warn',
            path,
            subpath,
            data: { detail: subplan.detail },
          });
        }
      }
    } else if (plan.comparator === 'discriminated-union') {
      for (const branchKey of Object.keys(plan.branches)) {
        const branchValue = JSON.parse(branchKey) as JSONValue;
        const branchLeaves = ownValue<Record<string, LeafPlan>>(
          plan.branches,
          branchKey,
        )!;
        for (const subpath of Object.keys(branchLeaves)) {
          const subplan = ownValue<LeafPlan>(branchLeaves, subpath)!;
          if (
            subplan.comparator === 'none' &&
            subplan.reason === 'unsupported'
          ) {
            findings.push({
              code: 'unsupported-schema',
              severity: 'warn',
              path,
              within: { branch: branchValue },
              subpath,
              data: { detail: subplan.detail },
            });
          }
        }
      }
    }

    // Field-level findings are suppressed when quorum.answered < 2.
    if (answered < 2 || res === undefined) continue;

    if (res.missing.length > 0 && res.presented.length >= 1) {
      findings.push({
        code: 'field-partial',
        severity: 'warn',
        path,
        witnesses: [...res.missing],
      });
    }

    if (
      plan.comparator === 'keyed-set' &&
      res.comparator === 'none' &&
      res.reason === 'duplicate-key'
    ) {
      findings.push({
        code: 'duplicate-key',
        severity: 'warn',
        path,
        witnesses: [...(res.duplicateKeyWitnesses ?? [])],
      });
      continue;
    }

    if (plan.comparator === 'keyed-set' && res.comparator === 'keyed-set') {
      let anyItemSplit = false;
      for (const item of res.items) {
        if (
          pushNestedLeafFindings(findings, {
            path,
            within: { key: item.key },
            planMap: plan.itemFields,
            fieldMap: item.fields,
          })
        ) {
          anyItemSplit = true;
        }
      }
      const hasNullVsArraySplit =
        res.nulls.length > 0 && res.nulls.length < res.presented.length;
      const hasKeySetDiff =
        res.keys.intersection.length !== res.keys.union.length;
      if (
        res.presented.length >= 2 &&
        res.status === 'split' &&
        (hasNullVsArraySplit || hasKeySetDiff || !anyItemSplit)
      ) {
        findings.push({
          code: 'field-split',
          severity: plan.onSplit,
          path,
          witnesses: [...res.presented],
        });
      }
      continue;
    }

    if (
      plan.comparator === 'discriminated-union' &&
      res.comparator === 'discriminated-union'
    ) {
      if (res.choice.status === 'split') {
        findings.push({
          code: 'field-split',
          severity: plan.onSplit,
          path,
          witnesses: [...res.choice.presented],
        });
      }
      for (const branch of res.branches) {
        const branchPlan = ownValue<Record<string, LeafPlan>>(
          plan.branches,
          canonicalJson(branch.value),
        );
        if (branchPlan === undefined) continue;
        pushNestedLeafFindings(findings, {
          path,
          within: { branch: branch.value },
          planMap: branchPlan,
          fieldMap: branch.fields,
        });
      }
      continue;
    }

    if (res.status === 'split' && plan.comparator !== 'none') {
      findings.push({
        code: 'field-split',
        severity: plan.onSplit,
        path,
        witnesses: [...res.presented],
      });
    }
  }

  if (coverage.unsupported + coverage.failedAtRuntime > 0) {
    findings.push({
      code: 'coverage-low',
      severity: strictCoverage ? 'critical' : 'warn',
      data: {
        compared: coverage.compared,
        fields: coverage.fields,
        ratio: coverage.ratio,
      },
    });
  }

  return sortFindings(findings);
}
