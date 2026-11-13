import type { Coverage, FieldPlan, FieldResult, LeafPlan } from '../types.js';

import { ownValue, toSortedNullProtoRecord } from './util.js';

function bumpReason(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Computes schema coverage over every plan entry at all depths (§9.3).
 */
export function computeCoverage<W extends string>(
  planFields: Record<string, FieldPlan>,
  fieldResults: Record<string, FieldResult<W>>,
): Coverage {
  let compared = 0;
  let notComparedByPolicy = 0;
  let unsupported = 0;
  let failedAtRuntime = 0;
  const reasonCounts = new Map<string, number>();

  function countLeaf(plan: LeafPlan, underFailedKeyedSet = false): void {
    if (plan.comparator === 'none') {
      if (plan.reason === 'policy') {
        notComparedByPolicy += 1;
      } else {
        unsupported += 1;
      }
      bumpReason(reasonCounts, plan.detail);
    } else if (underFailedKeyedSet) {
      failedAtRuntime += 1;
      bumpReason(reasonCounts, 'duplicate-key');
    } else {
      compared += 1;
    }
  }

  for (const path of Object.keys(planFields)) {
    const plan = ownValue<FieldPlan>(planFields, path)!;

    if (plan.comparator === 'keyed-set') {
      const result = ownValue<FieldResult<W>>(fieldResults, path);
      const isDupKey =
        result !== undefined &&
        result.comparator === 'none' &&
        result.reason === 'duplicate-key';

      if (isDupKey) {
        failedAtRuntime += 1;
        bumpReason(reasonCounts, 'duplicate-key');
      } else {
        compared += 1;
      }

      for (const subpath of Object.keys(plan.itemFields)) {
        countLeaf(ownValue<LeafPlan>(plan.itemFields, subpath)!, isDupKey);
      }
    } else if (plan.comparator === 'discriminated-union') {
      // Discriminator itself counts as one compared entry.
      compared += 1;
      for (const branchKey of Object.keys(plan.branches)) {
        const branchLeaves = ownValue<Record<string, LeafPlan>>(
          plan.branches,
          branchKey,
        )!;
        for (const subpath of Object.keys(branchLeaves)) {
          countLeaf(ownValue<LeafPlan>(branchLeaves, subpath)!, false);
        }
      }
    } else {
      countLeaf(plan, false);
    }
  }

  const fields = compared + notComparedByPolicy + unsupported + failedAtRuntime;
  const denom = fields - notComparedByPolicy;
  const ratio = denom === 0 ? 1 : compared / denom;

  return {
    fields,
    compared,
    notComparedByPolicy,
    unsupported,
    failedAtRuntime,
    ratio,
    byReason: toSortedNullProtoRecord(Array.from(reasonCounts.entries())),
  };
}
