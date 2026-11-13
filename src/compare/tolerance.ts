import type {
  FieldStatus,
  JSONValue,
  ToleranceResult,
  ToleranceSpec,
  ValueGroup,
} from '../types.js';

import { sortLabels, sortWith } from './util.js';

/**
 * Checks whether two finite numbers lie within the combined tolerance bound:
 * `|a - b| <= (absolute ?? 0) + (relative ?? 0) * max(|a|, |b|)`.
 */
export function withinTolerance(
  a: number,
  b: number,
  tolerance: ToleranceSpec,
): boolean {
  const abs = tolerance.absolute ?? 0;
  const rel = tolerance.relative ?? 0;
  return Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b));
}

function normalizeNumber(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * Evaluates a `tolerance` field comparison over already-extracted presenters.
 */
export function compareTolerance<W extends string>(params: {
  answered: number;
  presented: W[];
  missing: W[];
  nulls: W[];
  presentValues: Array<{ witness: W; value: JSONValue }>;
  tolerance: ToleranceSpec;
}): ToleranceResult<W> {
  const { answered, presented, missing, nulls, presentValues, tolerance } =
    params;

  const byNumber = new Map<number, W[]>();
  const nullWitnesses: W[] = [];

  for (const entry of presentValues) {
    if (entry.value === null) {
      nullWitnesses.push(entry.witness);
    } else if (
      typeof entry.value === 'number' &&
      Number.isFinite(entry.value)
    ) {
      const val = normalizeNumber(entry.value);
      const list = byNumber.get(val);
      if (list === undefined) {
        byNumber.set(val, [entry.witness]);
      } else {
        list.push(entry.witness);
      }
    }
  }

  const distinctNumbers = sortWith(
    Array.from(byNumber.keys()),
    (a, b) => a - b,
  );

  // Single-linkage grouping in ascending numeric order
  const groups: ToleranceResult<W>['groups'] = [];
  if (distinctNumbers.length > 0) {
    let currentValues: ValueGroup<W>[] = [];
    let currentMin = distinctNumbers[0]!;
    let currentMax = distinctNumbers[0]!;
    let currentSupport = 0;

    for (let i = 0; i < distinctNumbers.length; i++) {
      const val = distinctNumbers[i]!;
      const witnesses = sortLabels(byNumber.get(val)!);
      const valueGroup: ValueGroup<W> = {
        value: val,
        witnesses,
        support: witnesses.length,
      };

      if (i === 0) {
        currentValues = [valueGroup];
        currentMin = val;
        currentMax = val;
        currentSupport = witnesses.length;
      } else if (withinTolerance(distinctNumbers[i - 1]!, val, tolerance)) {
        currentValues.push(valueGroup);
        currentMax = val;
        currentSupport += witnesses.length;
      } else {
        groups.push({
          min: currentMin,
          max: currentMax,
          values: currentValues,
          support: currentSupport,
        });
        currentValues = [valueGroup];
        currentMin = val;
        currentMax = val;
        currentSupport = witnesses.length;
      }
    }

    groups.push({
      min: currentMin,
      max: currentMax,
      values: currentValues,
      support: currentSupport,
    });
  }

  // Pairwise withinTolerance check across all distinct numeric values
  let allPairsWithin = true;
  for (let i = 0; i < distinctNumbers.length && allPairsWithin; i++) {
    for (let j = i + 1; j < distinctNumbers.length; j++) {
      if (
        !withinTolerance(distinctNumbers[i]!, distinctNumbers[j]!, tolerance)
      ) {
        allPairsWithin = false;
        break;
      }
    }
  }

  let status: FieldStatus;
  if (presented.length < 2) {
    status = 'insufficient';
  } else if (nullWitnesses.length === 0) {
    status = allPairsWithin ? 'agree' : 'split';
  } else if (distinctNumbers.length === 0) {
    status = 'agree';
  } else {
    status = 'split';
  }

  const out: ToleranceResult<W> = {
    comparator: 'tolerance',
    status,
    answered,
    presented,
    missing,
    nulls,
    tolerance,
    groups,
  };

  if (distinctNumbers.length > 0) {
    const min = distinctNumbers[0]!;
    const max = distinctNumbers[distinctNumbers.length - 1]!;
    out.min = min;
    out.max = max;
    out.spread = normalizeNumber(max - min);
  }

  if (nullWitnesses.length > 0) {
    const sortedNullWitnesses = sortLabels(nullWitnesses);
    out.nullGroup = {
      witnesses: sortedNullWitnesses,
      support: sortedNullWitnesses.length,
    };
  }

  return out;
}
