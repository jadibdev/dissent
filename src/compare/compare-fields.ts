import { canonicalJson, compareUtf16 } from '../canonical/canonical-json.js';
import { parsePointer } from '../paths.js';

import type {
  ExactResult,
  FieldPlan,
  FieldResult,
  FieldStatus,
  JSONValue,
  KeyedSetResult,
  LeafPlan,
  LeafResult,
  NotComparedResult,
  SetResult,
  UnionResult,
  ValueGroup,
} from '../types.js';

import { compareTolerance } from './tolerance.js';
import {
  isPlainObject,
  ownValue,
  sortLabels,
  sortWith,
  toSortedNullProtoRecord,
} from './util.js';

export type AnsweredOutput<W extends string = string> = {
  witness: W;
  output: JSONValue;
};

function normalizeJsonZeros(value: JSONValue): JSONValue {
  if (typeof value === 'number') {
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const copy: JSONValue[] = [];
    for (const orig of value) {
      const norm = normalizeJsonZeros(orig as JSONValue);
      if (!Object.is(orig, norm)) changed = true;
      copy.push(norm);
    }
    return changed ? copy : value;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const out = Object.create(null) as Record<string, JSONValue>;
    let changed = false;
    for (const k of keys) {
      const orig = ownValue<JSONValue>(value, k) as JSONValue;
      const norm = normalizeJsonZeros(orig);
      if (!Object.is(orig, norm)) changed = true;
      Object.defineProperty(out, k, {
        value: norm,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Reads a value at an RFC 6901 JSON Pointer using `Object.hasOwn` at every
 * step. Intermediate non-objects (including `null` or arrays) make descendants
 * missing rather than throwing or reading prototype keys.
 */
export function readByPointer(
  root: JSONValue,
  pointer: string,
): { present: true; value: JSONValue } | { present: false } {
  if (pointer === '') {
    return { present: true, value: root };
  }
  let cur: unknown = root;
  for (const seg of parsePointer(pointer)) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, seg)) {
      return { present: false };
    }
    const next = ownValue(cur, seg);
    if (next === undefined) {
      return { present: false };
    }
    cur = next;
  }
  return { present: true, value: cur as JSONValue };
}

type ExtractedPresence<W extends string> = {
  presented: W[];
  missing: W[];
  nulls: W[];
  presentValues: Array<{ witness: W; value: JSONValue }>;
};

function extractPresence<W extends string>(
  outputs: ReadonlyArray<AnsweredOutput<W>>,
  pointer: string,
): ExtractedPresence<W> {
  const presented: W[] = [];
  const missing: W[] = [];
  const nulls: W[] = [];
  const presentValues: Array<{ witness: W; value: JSONValue }> = [];

  for (const entry of outputs) {
    const read = readByPointer(entry.output, pointer);
    if (!read.present) {
      missing.push(entry.witness);
      continue;
    }
    const value = normalizeJsonZeros(read.value);
    presented.push(entry.witness);
    if (value === null) {
      nulls.push(entry.witness);
    }
    presentValues.push({ witness: entry.witness, value });
  }

  return {
    presented: sortLabels(presented),
    missing: sortLabels(missing),
    nulls: sortLabels(nulls),
    presentValues: sortWith(presentValues, (a, b) =>
      compareUtf16(a.witness, b.witness),
    ),
  };
}

function buildExactGroups<W extends string>(
  presentValues: ReadonlyArray<{ witness: W; value: JSONValue }>,
): ValueGroup<W>[] {
  const byCanon = new Map<string, { value: JSONValue; witnesses: W[] }>();
  for (const entry of presentValues) {
    const key = canonicalJson(entry.value);
    const existing = byCanon.get(key);
    if (existing === undefined) {
      byCanon.set(key, { value: entry.value, witnesses: [entry.witness] });
    } else {
      existing.witnesses.push(entry.witness);
    }
  }

  return sortLabels(Array.from(byCanon.keys())).map(k => {
    const entry = byCanon.get(k)!;
    const witnesses = sortLabels(entry.witnesses);
    return { value: entry.value, witnesses, support: witnesses.length };
  });
}

function compareExact<W extends string>(
  answered: number,
  presence: ExtractedPresence<W>,
): ExactResult<W> {
  const groups = buildExactGroups(presence.presentValues);
  const status: FieldStatus =
    presence.presented.length < 2
      ? 'insufficient'
      : groups.length === 1
        ? 'agree'
        : 'split';

  return {
    comparator: 'exact',
    status,
    answered,
    presented: presence.presented,
    missing: presence.missing,
    nulls: presence.nulls,
    groups,
  };
}

type SetCore<W extends string> = {
  union: JSONValue[];
  intersection: JSONValue[];
  items: Array<{ item: JSONValue; witnesses: W[]; support: number }>;
  jaccard?: number;
  duplicates: W[];
};

function computeSetCore<W extends string>(
  nonNullArrays: ReadonlyArray<{ witness: W; values: JSONValue[] }>,
  nonArrayCount = 0,
): SetCore<W> {
  const itemMap = new Map<string, { item: JSONValue; witnesses: W[] }>();
  const duplicates: W[] = [];

  for (const entry of nonNullArrays) {
    const seen = new Set<string>();
    let hadDup = false;
    for (const rawItem of entry.values) {
      const item = normalizeJsonZeros(rawItem);
      const key = canonicalJson(item);
      if (seen.has(key)) {
        hadDup = true;
        continue;
      }
      seen.add(key);
      const existing = itemMap.get(key);
      if (existing === undefined) {
        itemMap.set(key, { item, witnesses: [entry.witness] });
      } else {
        existing.witnesses.push(entry.witness);
      }
    }
    if (hadDup) duplicates.push(entry.witness);
  }

  const nonNullCount = nonNullArrays.length + nonArrayCount;
  const sortedKeys = sortLabels(Array.from(itemMap.keys()));
  const union: JSONValue[] = [];
  const intersection: JSONValue[] = [];
  const items: Array<{ item: JSONValue; witnesses: W[]; support: number }> = [];

  for (const key of sortedKeys) {
    const entry = itemMap.get(key)!;
    const witnesses = sortLabels(entry.witnesses);
    union.push(entry.item);
    if (nonNullCount > 0 && witnesses.length === nonNullCount) {
      intersection.push(entry.item);
    }
    items.push({ item: entry.item, witnesses, support: witnesses.length });
  }

  const out: SetCore<W> = {
    union,
    intersection,
    items,
    duplicates: sortLabels(duplicates),
  };

  if (nonNullCount >= 2) {
    out.jaccard =
      nonArrayCount > 0
        ? 0
        : union.length === 0
          ? 1
          : intersection.length / union.length;
  }

  return out;
}

function compareSet<W extends string>(
  answered: number,
  presence: ExtractedPresence<W>,
): SetResult<W> {
  const nonNullArrays: Array<{ witness: W; values: JSONValue[] }> = [];
  let nonArrayCount = 0;

  for (const entry of presence.presentValues) {
    if (entry.value === null) continue;
    if (Array.isArray(entry.value)) {
      nonNullArrays.push({ witness: entry.witness, values: entry.value });
    } else {
      nonArrayCount += 1;
    }
  }

  const core = computeSetCore(nonNullArrays, nonArrayCount);
  const nullCount = presence.nulls.length;

  let status: FieldStatus;
  if (presence.presented.length < 2) {
    status = 'insufficient';
  } else if (nonArrayCount > 0) {
    status = 'split';
  } else if (nullCount === presence.presented.length) {
    status = 'agree';
  } else if (nullCount > 0) {
    status = 'split';
  } else if (core.intersection.length === core.union.length) {
    status = 'agree';
  } else {
    status = 'split';
  }

  const out: SetResult<W> = {
    comparator: 'set',
    status,
    answered,
    presented: presence.presented,
    missing: presence.missing,
    nulls: presence.nulls,
    union: core.union,
    intersection: core.intersection,
    items: core.items,
    duplicates: core.duplicates,
  };
  if (core.jaccard !== undefined) {
    out.jaccard = core.jaccard;
  }
  return out;
}

function compareNotCompared<W extends string>(
  plan: LeafPlan & { comparator: 'none' },
  answered: number,
  presence: ExtractedPresence<W>,
): NotComparedResult<W> {
  return {
    comparator: 'none',
    status: 'not-compared',
    reason: plan.reason,
    detail: plan.detail,
    answered,
    presented: presence.presented,
    missing: presence.missing,
    nulls: presence.nulls,
    values: presence.presentValues.map(entry => ({
      witness: entry.witness,
      value: entry.value,
    })),
  };
}

function compareLeaf<W extends string>(
  plan: LeafPlan,
  pointer: string,
  outputs: ReadonlyArray<AnsweredOutput<W>>,
): LeafResult<W> {
  const answered = outputs.length;
  const presence = extractPresence(outputs, pointer);

  switch (plan.comparator) {
    case 'exact':
      return compareExact(answered, presence);
    case 'tolerance':
      return compareTolerance({
        answered,
        presented: presence.presented,
        missing: presence.missing,
        nulls: presence.nulls,
        presentValues: presence.presentValues,
        tolerance: plan.tolerance,
      });
    case 'set':
      return compareSet(answered, presence);
    case 'none':
      return compareNotCompared(plan, answered, presence);
  }
}

function compareKeyedSet<W extends string>(
  plan: FieldPlan & { comparator: 'keyed-set' },
  pointer: string,
  outputs: ReadonlyArray<AnsweredOutput<W>>,
): KeyedSetResult<W> | NotComparedResult<W> {
  const answered = outputs.length;
  const presence = extractPresence(outputs, pointer);

  const duplicateKeyWitnesses: W[] = [];
  let nonArrayCount = 0;
  const witnessMaps = new Map<
    W,
    Map<string, { keyValue: JSONValue; item: JSONValue }>
  >();
  const keyRegistry = new Map<
    string,
    { keyValue: JSONValue; entries: Array<{ witness: W; output: JSONValue }> }
  >();
  const keySetArrays: Array<{ witness: W; values: JSONValue[] }> = [];

  for (const entry of presence.presentValues) {
    if (entry.value === null) continue;
    if (!Array.isArray(entry.value)) {
      nonArrayCount += 1;
      continue;
    }

    const wMap = new Map<string, { keyValue: JSONValue; item: JSONValue }>();
    const wKeys: JSONValue[] = [];
    let failed = false;

    for (const rawItem of entry.value) {
      if (!isPlainObject(rawItem) || !Object.hasOwn(rawItem, plan.key)) {
        failed = true;
        break;
      }
      const rawKeyVal = ownValue(rawItem, plan.key);
      if (rawKeyVal === undefined) {
        failed = true;
        break;
      }
      const keyVal = normalizeJsonZeros(rawKeyVal as JSONValue);
      const canonKey = canonicalJson(keyVal);
      if (wMap.has(canonKey)) {
        failed = true;
        break;
      }
      const normItem = normalizeJsonZeros(rawItem as JSONValue);
      wMap.set(canonKey, { keyValue: keyVal, item: normItem });
      wKeys.push(keyVal);
    }

    if (failed) {
      duplicateKeyWitnesses.push(entry.witness);
    } else {
      witnessMaps.set(entry.witness, wMap);
      keySetArrays.push({ witness: entry.witness, values: wKeys });
    }
  }

  if (duplicateKeyWitnesses.length > 0) {
    return {
      comparator: 'none',
      status: 'not-compared',
      reason: 'duplicate-key',
      detail: 'duplicate-key',
      answered,
      presented: presence.presented,
      missing: presence.missing,
      nulls: presence.nulls,
      values: presence.presentValues.map(entry => ({
        witness: entry.witness,
        value: entry.value,
      })),
      duplicateKeyWitnesses: sortLabels(duplicateKeyWitnesses),
    };
  }

  for (const [witness, wMap] of witnessMaps) {
    for (const [canonKey, info] of wMap) {
      const existing = keyRegistry.get(canonKey);
      if (existing === undefined) {
        keyRegistry.set(canonKey, {
          keyValue: info.keyValue,
          entries: [{ witness, output: info.item }],
        });
      } else {
        existing.entries.push({ witness, output: info.item });
      }
    }
  }

  const keysCore = computeSetCore(keySetArrays, nonArrayCount);
  const keysResult: KeyedSetResult<W>['keys'] = {
    union: keysCore.union,
    intersection: keysCore.intersection,
    items: keysCore.items,
  };
  if (keysCore.jaccard !== undefined) {
    keysResult.jaccard = keysCore.jaccard;
  }

  const sortedItemFieldKeys = sortLabels(Object.keys(plan.itemFields));
  const sortedKeyCanon = sortLabels(Array.from(keyRegistry.keys()));

  let anyItemFieldSplit = false;
  const items: KeyedSetResult<W>['items'] = [];

  for (const canonKey of sortedKeyCanon) {
    const reg = keyRegistry.get(canonKey)!;
    const sortedEntries = sortWith(reg.entries, (a, b) =>
      compareUtf16(a.witness, b.witness),
    );
    const witnesses = sortedEntries.map(e => e.witness);

    const fieldEntries: Array<[string, LeafResult<W>]> = [];
    for (const subpath of sortedItemFieldKeys) {
      const subplan = ownValue<LeafPlan>(plan.itemFields, subpath)!;
      const leafRes = compareLeaf(subplan, subpath, sortedEntries);
      if (leafRes.status === 'split') anyItemFieldSplit = true;
      fieldEntries.push([subpath, leafRes]);
    }

    items.push({
      key: reg.keyValue,
      witnesses,
      fields: toSortedNullProtoRecord(fieldEntries),
    });
  }

  let status: FieldStatus;
  if (presence.presented.length < 2) {
    status = 'insufficient';
  } else if (nonArrayCount > 0) {
    status = 'split';
  } else if (presence.nulls.length === presence.presented.length) {
    status = 'agree';
  } else if (presence.nulls.length > 0) {
    status = 'split';
  } else if (
    keysCore.intersection.length === keysCore.union.length &&
    !anyItemFieldSplit
  ) {
    status = 'agree';
  } else {
    status = 'split';
  }

  return {
    comparator: 'keyed-set',
    status,
    answered,
    presented: presence.presented,
    missing: presence.missing,
    nulls: presence.nulls,
    key: plan.key,
    keys: keysResult,
    items,
  };
}

function compareDiscriminatedUnion<W extends string>(
  plan: FieldPlan & { comparator: 'discriminated-union' },
  pointer: string,
  outputs: ReadonlyArray<AnsweredOutput<W>>,
): UnionResult<W> {
  const answered = outputs.length;
  const presence = extractPresence(outputs, pointer);

  const choicePresented: W[] = [];
  const choiceMissing: W[] = [];
  const choiceNulls: W[] = [];
  const choicePresentValues: Array<{ witness: W; value: JSONValue }> = [];

  const branchBuckets = new Map<
    string,
    { discValue: JSONValue; entries: Array<{ witness: W; output: JSONValue }> }
  >();

  for (const entry of presence.presentValues) {
    if (entry.value === null) {
      choicePresented.push(entry.witness);
      choiceNulls.push(entry.witness);
      choicePresentValues.push({ witness: entry.witness, value: null });
      continue;
    }

    if (
      !isPlainObject(entry.value) ||
      !Object.hasOwn(entry.value, plan.discriminator)
    ) {
      choiceMissing.push(entry.witness);
      continue;
    }

    const rawDisc = ownValue(entry.value, plan.discriminator);
    if (rawDisc === undefined) {
      choiceMissing.push(entry.witness);
      continue;
    }

    const discVal = normalizeJsonZeros(rawDisc as JSONValue);
    choicePresented.push(entry.witness);
    if (discVal === null) choiceNulls.push(entry.witness);
    choicePresentValues.push({ witness: entry.witness, value: discVal });

    const canonDisc = canonicalJson(discVal);
    if (Object.hasOwn(plan.branches, canonDisc)) {
      const bucket = branchBuckets.get(canonDisc);
      if (bucket === undefined) {
        branchBuckets.set(canonDisc, {
          discValue: discVal,
          entries: [{ witness: entry.witness, output: entry.value }],
        });
      } else {
        bucket.entries.push({ witness: entry.witness, output: entry.value });
      }
    }
  }

  const choice = compareExact(presence.presented.length, {
    presented: sortLabels(choicePresented),
    missing: sortLabels(choiceMissing),
    nulls: sortLabels(choiceNulls),
    presentValues: sortWith(choicePresentValues, (a, b) =>
      compareUtf16(a.witness, b.witness),
    ),
  });

  const branches: UnionResult<W>['branches'] = [];
  let anyBranchFieldSplit = false;

  for (const canonKey of sortLabels(Array.from(branchBuckets.keys()))) {
    const bucket = branchBuckets.get(canonKey)!;
    const sortedEntries = sortWith(bucket.entries, (a, b) =>
      compareUtf16(a.witness, b.witness),
    );
    const branchPlan = ownValue<Record<string, LeafPlan>>(
      plan.branches,
      canonKey,
    )!;
    const fieldEntries: Array<[string, LeafResult<W>]> = [];

    for (const subpath of sortLabels(Object.keys(branchPlan))) {
      const leafRes = compareLeaf(
        ownValue<LeafPlan>(branchPlan, subpath)!,
        subpath,
        sortedEntries,
      );
      if (leafRes.status === 'split') anyBranchFieldSplit = true;
      fieldEntries.push([subpath, leafRes]);
    }

    branches.push({
      value: bucket.discValue,
      witnesses: sortedEntries.map(e => e.witness),
      fields: toSortedNullProtoRecord(fieldEntries),
    });
  }

  let status: FieldStatus;
  if (presence.presented.length < 2 || choice.status === 'insufficient') {
    status = 'insufficient';
  } else if (choice.status === 'agree' && !anyBranchFieldSplit) {
    status = 'agree';
  } else {
    status = 'split';
  }

  return {
    comparator: 'discriminated-union',
    status,
    answered,
    presented: presence.presented,
    missing: presence.missing,
    nulls: presence.nulls,
    discriminator: plan.discriminator,
    choice,
    branches,
  };
}

function normalizeOutputs<W extends string>(
  answeredOutputs: ReadonlyArray<AnsweredOutput<W>> | Record<W, JSONValue>,
): AnsweredOutput<W>[] {
  const list: AnsweredOutput<W>[] = Array.isArray(answeredOutputs)
    ? [...answeredOutputs]
    : Object.keys(answeredOutputs as Record<string, JSONValue>).map(
        witness => ({
          witness: witness as W,
          output: ownValue<JSONValue>(
            answeredOutputs as Record<string, JSONValue>,
            witness,
          )!,
        }),
      );
  return sortWith(list, (a, b) => compareUtf16(a.witness, b.witness));
}

/**
 * Pure Layer B field comparison over answered witness outputs.
 * Every answering witness participates (I2) and insertion order never affects output (I3).
 */
export function compareFields<W extends string>(
  planFields: Record<string, FieldPlan>,
  answeredOutputs: ReadonlyArray<AnsweredOutput<W>> | Record<W, JSONValue>,
): Record<string, FieldResult<W>> {
  const outputs = normalizeOutputs(answeredOutputs);
  const resultEntries: Array<[string, FieldResult<W>]> = [];

  for (const path of sortLabels(Object.keys(planFields))) {
    const plan = ownValue<FieldPlan>(planFields, path)!;
    let res: FieldResult<W>;
    switch (plan.comparator) {
      case 'exact':
      case 'tolerance':
      case 'set':
      case 'none':
        res = compareLeaf(plan, path, outputs);
        break;
      case 'keyed-set':
        res = compareKeyedSet(plan, path, outputs);
        break;
      case 'discriminated-union':
        res = compareDiscriminatedUnion(plan, path, outputs);
        break;
    }
    resultEntries.push([path, res]);
  }

  return toSortedNullProtoRecord(resultEntries);
}
