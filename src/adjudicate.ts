import { canonicalJson, compareUtf16 } from './canonical/canonical-json.js';
import { sha256Hex } from './canonical/sha256.js';
import { readByPointer } from './compare/compare-fields.js';
import { withinTolerance } from './compare/tolerance.js';
import {
  isPlainObject,
  normalizeJsonZeros,
  ownValue,
  sortLabels,
  sortWith,
} from './compare/util.js';
import { DissentArgumentError } from './errors.js';
import { normalizePath, parsePointer } from './paths.js';
import { readReceiptId, validateOfflineReceipt } from './receipt.js';
import { redactSecrets, sanitizeInline } from './sanitize.js';

import type {
  AdjudicateOptions,
  Adjudication,
  Evidence,
  EvidenceOutcome,
  FieldPlan,
  JSONValue,
  Ledger,
  Settlement,
  Verdict,
  VerdictReason,
  WitnessRecord,
} from './types.js';

const OUTCOMES = new Set<EvidenceOutcome>(['pass', 'fail', 'error', 'unknown']);
const MAX_SOURCE_CHARS = 128;

type ReceiptExpected = {
  networkPolicySha256?: string;
  runtimeImageDigest?: string;
};

type ValidatedItem = {
  source: string;
  outcome: EvidenceOutcome;
  normalizedForHash: Record<string, JSONValue>;
  claim?: { scope: 'artifact' } | { path: string; value: JSONValue };
  receipt?: unknown;
};

function assertJsonValue(value: unknown, argumentPath: string): JSONValue {
  try {
    canonicalJson(value);
  } catch {
    throw new DissentArgumentError('invalid-evidence', argumentPath);
  }
  return normalizeJsonZeros(value as JSONValue);
}

const ALLOWED_ADJUDICATE_OPTIONS = new Set([
  'escalateOnReview',
  'requireOfflineReceipt',
]);
const ALLOWED_RECEIPT_EXPECTED_KEYS = new Set([
  'networkPolicySha256',
  'runtimeImageDigest',
]);

function validateAdjudicateOptions(options: unknown): {
  escalateOnReview: boolean;
  requireOfflineReceipt: false | true | ReceiptExpected;
} {
  if (options === undefined) {
    return { escalateOnReview: false, requireOfflineReceipt: false };
  }
  if (!isPlainObject(options)) {
    throw new DissentArgumentError('invalid-option', 'options');
  }

  for (const key of Object.keys(options)) {
    if (!ALLOWED_ADJUDICATE_OPTIONS.has(key)) {
      throw new DissentArgumentError('invalid-option', `options.${key}`);
    }
  }

  const escalate = ownValue(options, 'escalateOnReview');
  if (escalate !== undefined && typeof escalate !== 'boolean') {
    throw new DissentArgumentError('invalid-option', 'escalateOnReview');
  }

  const rawReq = ownValue(options, 'requireOfflineReceipt');
  let requireOfflineReceipt: false | true | ReceiptExpected = false;

  if (rawReq === true || rawReq === false || rawReq === undefined) {
    requireOfflineReceipt = rawReq === true;
  } else if (isPlainObject(rawReq)) {
    for (const key of Object.keys(rawReq)) {
      if (!ALLOWED_RECEIPT_EXPECTED_KEYS.has(key)) {
        throw new DissentArgumentError(
          'invalid-option',
          `requireOfflineReceipt.${key}`,
        );
      }
    }
    const normalized: ReceiptExpected = {};
    const sha = ownValue(rawReq, 'networkPolicySha256');
    if (sha !== undefined) {
      if (typeof sha !== 'string') {
        throw new DissentArgumentError(
          'invalid-option',
          'requireOfflineReceipt.networkPolicySha256',
        );
      }
      normalized.networkPolicySha256 = sha;
    }
    const digest = ownValue(rawReq, 'runtimeImageDigest');
    if (digest !== undefined) {
      if (typeof digest !== 'string') {
        throw new DissentArgumentError(
          'invalid-option',
          'requireOfflineReceipt.runtimeImageDigest',
        );
      }
      normalized.runtimeImageDigest = digest;
    }
    requireOfflineReceipt =
      Object.keys(normalized).length === 0 ? true : normalized;
  } else {
    throw new DissentArgumentError('invalid-option', 'requireOfflineReceipt');
  }

  return {
    escalateOnReview: escalate === true,
    requireOfflineReceipt,
  };
}

function validateEvidenceItem(raw: unknown, index: number): ValidatedItem {
  if (!isPlainObject(raw)) {
    throw new DissentArgumentError('invalid-evidence', `evidence[${index}]`);
  }

  const rawSource = ownValue(raw, 'source');
  if (typeof rawSource !== 'string') {
    throw new DissentArgumentError(
      'invalid-evidence',
      `evidence[${index}].source`,
    );
  }
  const source = redactSecrets(sanitizeInline(rawSource));
  if (source.trim().length === 0 || source.length > MAX_SOURCE_CHARS) {
    throw new DissentArgumentError(
      'invalid-evidence',
      `evidence[${index}].source`,
    );
  }

  const rawOutcome = ownValue(raw, 'outcome');
  if (
    typeof rawOutcome !== 'string' ||
    !OUTCOMES.has(rawOutcome as EvidenceOutcome)
  ) {
    throw new DissentArgumentError(
      'invalid-evidence',
      `evidence[${index}].outcome`,
    );
  }
  const outcome = rawOutcome as EvidenceOutcome;

  const forHash: Record<string, JSONValue> = {
    source,
    outcome,
  };

  let claim: ValidatedItem['claim'];
  const rawClaim = ownValue(raw, 'claim');
  if (rawClaim !== undefined) {
    if (!isPlainObject(rawClaim)) {
      throw new DissentArgumentError(
        'invalid-evidence',
        `evidence[${index}].claim`,
      );
    }
    const hasScope = Object.hasOwn(rawClaim, 'scope');
    const hasPath = Object.hasOwn(rawClaim, 'path');
    if (hasScope && !hasPath) {
      if (ownValue(rawClaim, 'scope') !== 'artifact') {
        throw new DissentArgumentError(
          'invalid-evidence',
          `evidence[${index}].claim.scope`,
        );
      }
      claim = { scope: 'artifact' };
      forHash.claim = { scope: 'artifact' };
    } else if (hasPath && !hasScope) {
      const rawPath = ownValue(rawClaim, 'path');
      if (typeof rawPath !== 'string') {
        throw new DissentArgumentError(
          'invalid-evidence',
          `evidence[${index}].claim.path`,
        );
      }
      let normalizedPath: string;
      try {
        normalizedPath = normalizePath(rawPath);
        parsePointer(normalizedPath);
      } catch {
        throw new DissentArgumentError(
          'invalid-evidence',
          `evidence[${index}].claim.path`,
        );
      }
      if (
        !Object.hasOwn(rawClaim, 'value') ||
        ownValue(rawClaim, 'value') === undefined
      ) {
        throw new DissentArgumentError(
          'invalid-evidence',
          `evidence[${index}].claim.value`,
        );
      }
      const value = assertJsonValue(
        ownValue(rawClaim, 'value'),
        `evidence[${index}].claim.value`,
      );
      claim = { path: normalizedPath, value };
      forHash.claim = { path: normalizedPath, value };
    } else {
      throw new DissentArgumentError(
        'invalid-evidence',
        `evidence[${index}].claim`,
      );
    }
  }

  const details = ownValue(raw, 'details');
  if (details !== undefined) {
    if (!isPlainObject(details)) {
      throw new DissentArgumentError(
        'invalid-evidence',
        `evidence[${index}].details`,
      );
    }
    forHash.details = assertJsonValue(details, `evidence[${index}].details`);
  }

  const claims = ownValue(raw, 'claims');
  if (claims !== undefined) {
    if (!isPlainObject(claims)) {
      throw new DissentArgumentError(
        'invalid-evidence',
        `evidence[${index}].claims`,
      );
    }
    forHash.claims = assertJsonValue(claims, `evidence[${index}].claims`);
  }

  const receipt = ownValue(raw, 'receipt');
  if (receipt !== undefined) {
    forHash.receipt = assertJsonValue(receipt, `evidence[${index}].receipt`);
  }

  const out: ValidatedItem = { source, outcome, normalizedForHash: forHash };
  if (claim !== undefined) out.claim = claim;
  if (receipt !== undefined) out.receipt = receipt;
  return out;
}

function toCanonicalSet(values: readonly JSONValue[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    out.add(canonicalJson(v));
  }
  return out;
}

function buildKeyedMap(
  values: unknown,
  keyName: string,
): Map<string, string> | null {
  if (!Array.isArray(values)) return null;
  const map = new Map<string, string>();
  for (const item of values) {
    if (!isPlainObject(item) || !Object.hasOwn(item, keyName)) return null;
    const keyVal = ownValue(item, keyName);
    if (keyVal === undefined) return null;
    const canonKey = canonicalJson(keyVal);
    if (map.has(canonKey)) return null;
    map.set(canonKey, canonicalJson(item));
  }
  return map;
}

function valuesMatchByPlan(
  plan: FieldPlan,
  a: JSONValue,
  b: JSONValue,
): boolean {
  switch (plan.comparator) {
    case 'none':
      return false;
    case 'exact':
    case 'discriminated-union':
      return canonicalJson(a) === canonicalJson(b);
    case 'tolerance':
      if (a === null && b === null) return true;
      if (
        typeof a === 'number' &&
        Number.isFinite(a) &&
        typeof b === 'number' &&
        Number.isFinite(b)
      ) {
        return withinTolerance(a, b, plan.tolerance);
      }
      return false;
    case 'set': {
      if (a === null && b === null) return true;
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      const setA = toCanonicalSet(a as JSONValue[]);
      const setB = toCanonicalSet(b as JSONValue[]);
      if (setA.size !== setB.size) return false;
      for (const k of setA) {
        if (!setB.has(k)) return false;
      }
      return true;
    }
    case 'keyed-set': {
      if (a === null && b === null) return true;
      const mapA = buildKeyedMap(a, plan.key);
      const mapB = buildKeyedMap(b, plan.key);
      if (mapA === null || mapB === null || mapA.size !== mapB.size) {
        return false;
      }
      for (const [k, v] of mapA) {
        if (mapB.get(k) !== v) return false;
      }
      return true;
    }
  }
}

function computeVerdict(
  counts: { pass: number; fail: number; error: number; unknown: number },
  totalArtifact: number,
  escalateOnReview: boolean,
  advisory: Ledger<unknown, string>['advisory'],
): { verdict: Verdict; verdictReason: VerdictReason } {
  if (totalArtifact === 0) {
    return { verdict: 'uncertain', verdictReason: 'no-artifact-evidence' };
  }
  if (counts.fail > 0) {
    return { verdict: 'rejected', verdictReason: 'artifact-evidence-failed' };
  }
  if (counts.error > 0 || counts.unknown > 0) {
    return {
      verdict: 'uncertain',
      verdictReason: 'artifact-evidence-inconclusive',
    };
  }
  if (escalateOnReview && advisory === 'review-required') {
    return { verdict: 'uncertain', verdictReason: 'escalated-on-review' };
  }
  return { verdict: 'confirmed', verdictReason: 'artifact-evidence-passed' };
}

/**
 * Pure Layer C adjudication: binds caller evidence to ledger fields (settlements, conflicts)
 * and computes the artifact verdict without calling any model (§10).
 */
export async function adjudicate<W extends string>(
  ledger: Ledger<unknown, W>,
  evidence: readonly Evidence[],
  options?: AdjudicateOptions,
): Promise<Adjudication<W>> {
  if (
    !isPlainObject(ledger) ||
    typeof ledger.fingerprint !== 'string' ||
    !isPlainObject(ledger.plan) ||
    !isPlainObject(ledger.plan.fields) ||
    !isPlainObject(ledger.witnesses)
  ) {
    throw new DissentArgumentError('invalid-option', 'ledger');
  }
  if (!Array.isArray(evidence)) {
    throw new DissentArgumentError('invalid-evidence', 'evidence');
  }

  const resolvedOpts = validateAdjudicateOptions(options);
  const validated = evidence.map((item, i) => validateEvidenceItem(item, i));

  const allWitnesses = sortLabels(Object.keys(ledger.witnesses) as W[]);
  const answeredPresenters = new Map<W, JSONValue>();
  for (const w of allWitnesses) {
    const rec = ownValue<WitnessRecord<unknown>>(ledger.witnesses, w);
    if (rec?.status === 'answered') {
      answeredPresenters.set(w, rec.output as JSONValue);
    }
  }

  const settlements: Settlement<W>[] = [];
  const boundByPath = new Map<
    string,
    {
      plan: FieldPlan;
      entries: Array<{
        source: string;
        outcome: EvidenceOutcome;
        value: JSONValue;
      }>;
    }
  >();
  const unbound: Adjudication<W>['unbound'] = [];
  const receiptChecks: Adjudication<W>['receiptChecks'] = [];
  const artifactCounts = { pass: 0, fail: 0, error: 0, unknown: 0 };
  let totalArtifact = 0;

  for (const item of validated) {
    if (item.claim === undefined) {
      unbound.push({
        source: item.source,
        outcome: item.outcome,
        reason: 'no-claim',
      });
      continue;
    }

    if ('scope' in item.claim) {
      totalArtifact += 1;
      let effectiveOutcome = item.outcome;
      if (resolvedOpts.requireOfflineReceipt !== false) {
        const expected =
          resolvedOpts.requireOfflineReceipt === true
            ? undefined
            : resolvedOpts.requireOfflineReceipt;
        const check = validateOfflineReceipt(item.receipt, expected);
        receiptChecks.push({
          source: item.source,
          receiptId: readReceiptId(item.receipt),
          check,
        });
        if (!check.valid) {
          effectiveOutcome = 'unknown';
        }
      }
      artifactCounts[effectiveOutcome] += 1;
      continue;
    }

    const { path, value } = item.claim;
    if (!Object.hasOwn(ledger.plan.fields, path)) {
      unbound.push({
        source: item.source,
        outcome: item.outcome,
        reason: 'unknown-path',
      });
      continue;
    }
    const plan = ownValue<FieldPlan>(ledger.plan.fields, path)!;

    let pathBucket = boundByPath.get(path);
    if (pathBucket === undefined) {
      pathBucket = { plan, entries: [] };
      boundByPath.set(path, pathBucket);
    }
    pathBucket.entries.push({
      source: item.source,
      outcome: item.outcome,
      value,
    });

    if (plan.comparator === 'none') {
      settlements.push({
        path,
        value,
        source: item.source,
        outcome: item.outcome,
        comparator: 'not-comparable',
        witnessesAgreeing: [],
        witnessesDissenting: [],
        witnessesSilent: [...allWitnesses],
      });
      continue;
    }

    const witnessesAgreeing: W[] = [];
    const witnessesDissenting: W[] = [];
    const witnessesSilent: W[] = [];

    for (const w of allWitnesses) {
      const output = answeredPresenters.get(w);
      if (output === undefined) {
        witnessesSilent.push(w);
        continue;
      }
      const read = readByPointer(output, path);
      if (!read.present) {
        witnessesSilent.push(w);
        continue;
      }
      const witnessValue = normalizeJsonZeros(read.value);
      if (valuesMatchByPlan(plan, witnessValue, value)) {
        witnessesAgreeing.push(w);
      } else {
        witnessesDissenting.push(w);
      }
    }

    settlements.push({
      path,
      value,
      source: item.source,
      outcome: item.outcome,
      comparator: plan.comparator,
      witnessesAgreeing,
      witnessesDissenting,
      witnessesSilent,
    });
  }

  const conflicts: Adjudication<W>['conflicts'] = [];
  for (const path of sortLabels(Array.from(boundByPath.keys()))) {
    const { plan, entries } = boundByPath.get(path)!;
    if (plan.comparator === 'none') continue;
    const involved = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]!;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j]!;
        const bothPass = a.outcome === 'pass' && b.outcome === 'pass';
        const passFail =
          (a.outcome === 'pass' && b.outcome === 'fail') ||
          (a.outcome === 'fail' && b.outcome === 'pass');
        if (!bothPass && !passFail) continue;
        const match = valuesMatchByPlan(plan, a.value, b.value);
        if ((bothPass && !match) || (passFail && match)) {
          involved.add(a.source);
          involved.add(b.source);
        }
      }
    }
    if (involved.size > 0) {
      conflicts.push({ path, sources: sortLabels(Array.from(involved)) });
    }
  }

  const sortedSettlements = sortWith(settlements, (a, b) => {
    const pathCmp = compareUtf16(a.path, b.path);
    if (pathCmp !== 0) return pathCmp;
    const valCmp = compareUtf16(canonicalJson(a.value), canonicalJson(b.value));
    if (valCmp !== 0) return valCmp;
    const srcCmp = compareUtf16(a.source, b.source);
    if (srcCmp !== 0) return srcCmp;
    return compareUtf16(a.outcome, b.outcome);
  });

  const sortedUnbound = sortWith(unbound, (a, b) => {
    const srcCmp = compareUtf16(a.source, b.source);
    if (srcCmp !== 0) return srcCmp;
    const outCmp = compareUtf16(a.outcome, b.outcome);
    if (outCmp !== 0) return outCmp;
    return compareUtf16(a.reason, b.reason);
  });

  const sortedReceiptChecks = sortWith(receiptChecks, (a, b) => {
    const srcCmp = compareUtf16(a.source, b.source);
    if (srcCmp !== 0) return srcCmp;
    const idCmp = compareUtf16(a.receiptId ?? '', b.receiptId ?? '');
    if (idCmp !== 0) return idCmp;
    return compareUtf16(canonicalJson(a.check), canonicalJson(b.check));
  });

  const sortedEvidenceForHash = sortWith(
    validated.map(v => ({
      canon: canonicalJson(v.normalizedForHash),
      item: v.normalizedForHash,
    })),
    (a, b) => compareUtf16(a.canon, b.canon),
  ).map(e => e.item);

  const fingerprint = await sha256Hex(
    canonicalJson({
      protocol: 'dissent-adjudication/1',
      ledgerFingerprint: ledger.fingerprint,
      evidence: sortedEvidenceForHash,
      options: resolvedOpts,
    }),
  );

  const { verdict, verdictReason } = computeVerdict(
    artifactCounts,
    totalArtifact,
    resolvedOpts.escalateOnReview,
    ledger.advisory,
  );

  return {
    protocol: 'dissent-adjudication/1',
    ledgerFingerprint: ledger.fingerprint,
    fingerprint,
    settlements: sortedSettlements,
    conflicts,
    verdict,
    verdictReason,
    artifactEvidence: artifactCounts,
    receiptChecks: sortedReceiptChecks,
    unbound: sortedUnbound,
  };
}
