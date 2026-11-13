import { canonicalJson } from '../canonical/canonical-json.js';
import { sha256Hex } from '../canonical/sha256.js';
import { DissentArgumentError } from '../errors.js';
import { appendPointer, normalizePath } from '../paths.js';

import type {
  ComparatorOverride,
  CompareOverrides,
  FieldPlan,
  LeafPlan,
  NotComparedDetail,
  PlanReason,
  Severity,
  ToleranceSpec,
} from '../types.js';

import { isPlainObject, ownValue, toSortedNullProtoRecord } from './util.js';
import {
  collectWalkedPaths,
  isValidKeySchema,
  walkSchema,
  type WalkedArray,
  type WalkedLeaf,
  type WalkedNode,
  type WalkedObject,
  type WalkedUnion,
} from './walk-schema.js';

export type DerivedPlan = {
  fingerprint: string;
  fields: Record<string, FieldPlan>;
};

const VALID_SEVERITIES = new Set<string>(['info', 'warn', 'critical']);

function mergeReasons(base: PlanReason[], extra: PlanReason[]): PlanReason[] {
  const result: PlanReason[] = [];
  for (const r of base) {
    if (!result.includes(r)) result.push(r);
  }
  for (const r of extra) {
    if (!result.includes(r)) result.push(r);
  }
  return result;
}

function contextReasons(reasons: PlanReason[]): PlanReason[] {
  return reasons.filter(r => r === 'nullable-unwrap' || r === 'ref-resolved');
}

function nonePlan(opts: {
  reason: 'policy' | 'unsupported';
  detail: NotComparedDetail;
  reasons: PlanReason[];
  nullable: boolean;
}): LeafPlan {
  return {
    comparator: 'none',
    reason: opts.reason,
    detail: opts.detail,
    reasons: mergeReasons(opts.reasons, [opts.reason]),
    nullable: opts.nullable,
  };
}

function callerNonePlan(
  baseReasons: PlanReason[],
  nullable: boolean,
): LeafPlan {
  return {
    comparator: 'none',
    reason: 'policy',
    detail: 'caller-none',
    reasons: mergeReasons(baseReasons, ['caller-override', 'policy']),
    nullable,
  };
}

function validateSeverity(value: unknown, path: string): Severity {
  if (typeof value !== 'string' || !VALID_SEVERITIES.has(value)) {
    throw new DissentArgumentError(
      'invalid-option',
      `compare.${path}`,
      `Invalid severity in override for "${path}"`,
    );
  }
  return value as Severity;
}

function checkToleranceBound(
  spec: Record<string, unknown>,
  field: 'absolute' | 'relative',
  path: string,
): number | undefined {
  if (!Object.hasOwn(spec, field) || spec[field] === undefined) {
    return undefined;
  }
  const val = ownValue(spec, field);
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    throw new DissentArgumentError(
      'invalid-tolerance',
      path,
      `Tolerance ${field} at "${path}" must be a finite number >= 0`,
    );
  }
  return val === 0 ? 0 : val;
}

function validateTolerance(spec: unknown, path: string): ToleranceSpec {
  if (!isPlainObject(spec)) {
    throw new DissentArgumentError(
      'invalid-tolerance',
      path,
      `Tolerance for "${path}" must be a plain object`,
    );
  }
  for (const k of Object.keys(spec)) {
    if (k !== 'absolute' && k !== 'relative') {
      throw new DissentArgumentError(
        'invalid-tolerance',
        path,
        `Unknown tolerance key "${k}" at "${path}"`,
      );
    }
  }

  const abs = checkToleranceBound(spec, 'absolute', path);
  const rel = checkToleranceBound(spec, 'relative', path);
  if (abs === undefined && rel === undefined) {
    throw new DissentArgumentError(
      'invalid-tolerance',
      path,
      `Tolerance at "${path}" requires at least one of absolute or relative`,
    );
  }

  const out: ToleranceSpec = {};
  if (abs !== undefined) out.absolute = abs;
  if (rel !== undefined) out.relative = rel;
  return out;
}

type NormalizedOverride =
  | { kind: 'exact'; onSplit?: Severity }
  | { kind: 'set'; onSplit?: Severity }
  | { kind: 'none' }
  | { kind: 'onSplit-only'; onSplit: Severity }
  | { kind: 'tolerance'; tolerance: unknown; onSplit?: Severity }
  | { kind: 'keyed-set'; key: unknown; onSplit?: Severity };

function assertAllowedKeys(
  keys: readonly string[],
  allowed: ReadonlySet<string>,
  label: string,
  path: string,
): void {
  for (const k of keys) {
    if (!allowed.has(k)) {
      throw new DissentArgumentError(
        'incompatible-override',
        path,
        `Unexpected key "${k}" in ${label} override at "${path}"`,
      );
    }
  }
}

function optionalOnSplit(
  raw: Record<string, unknown>,
  path: string,
): Severity | undefined {
  if (!Object.hasOwn(raw, 'onSplit') || raw.onSplit === undefined) {
    return undefined;
  }
  return validateSeverity(ownValue(raw, 'onSplit'), path);
}

function parseOverride(raw: unknown, path: string): NormalizedOverride {
  if (raw === 'exact' || raw === 'set' || raw === 'none') {
    return { kind: raw };
  }
  if (!isPlainObject(raw)) {
    throw new DissentArgumentError(
      'invalid-option',
      `compare.${path}`,
      `Invalid override value at "${path}"`,
    );
  }

  const keys = Object.keys(raw);
  if (Object.hasOwn(raw, 'comparator')) {
    assertAllowedKeys(
      keys,
      new Set(['comparator', 'onSplit']),
      'comparator',
      path,
    );
    const comp = ownValue(raw, 'comparator');
    if (comp === 'none') {
      if (Object.hasOwn(raw, 'onSplit') && raw.onSplit !== undefined) {
        throw new DissentArgumentError(
          'incompatible-override',
          path,
          `Override "none" at "${path}" cannot specify onSplit`,
        );
      }
      return { kind: 'none' };
    }
    if (comp === 'exact' || comp === 'set') {
      const onSplit = optionalOnSplit(raw, path);
      return onSplit !== undefined ? { kind: comp, onSplit } : { kind: comp };
    }
    throw new DissentArgumentError(
      'incompatible-override',
      path,
      `Unsupported comparator override "${String(comp)}" at "${path}"`,
    );
  }

  if (Object.hasOwn(raw, 'tolerance')) {
    assertAllowedKeys(
      keys,
      new Set(['tolerance', 'onSplit']),
      'tolerance',
      path,
    );
    const onSplit = optionalOnSplit(raw, path);
    const tolerance = ownValue(raw, 'tolerance');
    return onSplit !== undefined
      ? { kind: 'tolerance', tolerance, onSplit }
      : { kind: 'tolerance', tolerance };
  }

  if (Object.hasOwn(raw, 'key')) {
    assertAllowedKeys(keys, new Set(['key', 'onSplit']), 'keyed-set', path);
    const onSplit = optionalOnSplit(raw, path);
    const key = ownValue(raw, 'key');
    return onSplit !== undefined
      ? { kind: 'keyed-set', key, onSplit }
      : { kind: 'keyed-set', key };
  }

  if (Object.hasOwn(raw, 'onSplit') && keys.length === 1) {
    return {
      kind: 'onSplit-only',
      onSplit: validateSeverity(ownValue(raw, 'onSplit'), path),
    };
  }

  throw new DissentArgumentError(
    'invalid-option',
    `compare.${path}`,
    `Unrecognized override shape at "${path}"`,
  );
}

function getArrayPolicyOrUnsupportedDetail(
  items: WalkedNode | null,
): { reason: 'policy' | 'unsupported'; detail: NotComparedDetail } | null {
  if (items === null) return { reason: 'unsupported', detail: 'tuple' };
  if (items.kind === 'array') {
    return { reason: 'unsupported', detail: 'nested-array' };
  }
  if (items.kind === 'object') {
    return { reason: 'unsupported', detail: 'object-array-requires-key' };
  }
  if (items.kind === 'discriminated-union') {
    return { reason: 'unsupported', detail: 'union' };
  }
  if (items.primitiveType === 'number') {
    return { reason: 'policy', detail: 'number-array' };
  }
  if (
    items.primitiveType === 'integer' ||
    items.primitiveType === 'boolean' ||
    items.primitiveType === 'string' ||
    items.isBooleanEnumConst
  ) {
    return null;
  }
  if (items.plan.comparator === 'none' && items.plan.reason === 'unsupported') {
    return { reason: 'unsupported', detail: items.plan.detail };
  }
  return { reason: 'unsupported', detail: 'untyped' };
}

function planDefaultArray(node: WalkedArray): LeafPlan {
  if (node.tuple) {
    return nonePlan({
      reason: 'unsupported',
      detail: 'tuple',
      reasons: node.reasons,
      nullable: node.nullable,
    });
  }

  const itemReasons =
    node.items?.kind === 'leaf'
      ? contextReasons(node.items.plan.reasons)
      : node.items !== null
        ? contextReasons(node.items.reasons)
        : [];
  const baseReasons = mergeReasons(node.reasons, itemReasons);

  const nonSet = getArrayPolicyOrUnsupportedDetail(node.items);
  if (nonSet !== null) {
    return nonePlan({
      reason: nonSet.reason,
      detail: nonSet.detail,
      reasons: baseReasons,
      nullable: node.nullable,
    });
  }

  return {
    comparator: 'set',
    onSplit: 'warn',
    reasons: mergeReasons(baseReasons, ['default-by-type']),
    nullable: node.nullable,
  };
}

function planNestedObjectLeaves(
  obj: WalkedObject,
  prefix: string,
  out: Array<[string, LeafPlan]>,
  excludeTopKey?: string,
): void {
  if (obj.additionalProperties) {
    out.push([
      prefix,
      nonePlan({
        reason: 'unsupported',
        detail: 'additional-properties',
        reasons: obj.reasons,
        nullable: obj.nullable,
      }),
    ]);
  }

  for (const [propName, child] of obj.properties) {
    if (prefix === '' && propName === excludeTopKey) continue;
    const childPath = appendPointer(prefix, propName);
    if (child.kind === 'leaf') {
      out.push([childPath, child.plan]);
    } else if (child.kind === 'object') {
      planNestedObjectLeaves(child, childPath, out);
    } else if (child.kind === 'array') {
      out.push([childPath, planDefaultArray(child)]);
    } else {
      // D9: nested discriminated union inside keyed-set item or union branch
      out.push([
        childPath,
        nonePlan({
          reason: 'unsupported',
          detail: 'nested-composite',
          reasons: contextReasons(child.reasons),
          nullable: child.nullable,
        }),
      ]);
    }
  }
}

function planLeafWithOverride(
  leaf: WalkedLeaf,
  override: NormalizedOverride | undefined,
  path: string,
): LeafPlan {
  if (override === undefined) return leaf.plan;
  const baseCtx = contextReasons(leaf.plan.reasons);

  switch (override.kind) {
    case 'exact':
      return {
        comparator: 'exact',
        onSplit:
          override.onSplit ?? (leaf.isBooleanEnumConst ? 'critical' : 'warn'),
        reasons: mergeReasons(baseCtx, ['caller-override']),
        nullable: leaf.plan.nullable,
      };
    case 'none':
      return callerNonePlan(baseCtx, leaf.plan.nullable);
    case 'tolerance': {
      if (leaf.primitiveType !== 'number' && leaf.primitiveType !== 'integer') {
        throw new DissentArgumentError(
          'incompatible-override',
          path,
          `Tolerance override at "${path}" requires a number or integer schema`,
        );
      }
      return {
        comparator: 'tolerance',
        tolerance: validateTolerance(override.tolerance, path),
        onSplit: override.onSplit ?? 'warn',
        reasons: mergeReasons(baseCtx, ['caller-override']),
        nullable: leaf.plan.nullable,
      };
    }
    case 'onSplit-only': {
      if (leaf.plan.comparator === 'none') {
        throw new DissentArgumentError(
          'incompatible-override',
          path,
          `Override { onSplit } at "${path}" requires a non-none default comparator`,
        );
      }
      return {
        ...leaf.plan,
        onSplit: override.onSplit,
        reasons: mergeReasons(leaf.plan.reasons, ['caller-override']),
      };
    }
    case 'set':
    case 'keyed-set':
      throw new DissentArgumentError(
        'incompatible-override',
        path,
        `Override "${override.kind}" at "${path}" requires an array schema`,
      );
  }
}

function planArrayWithOverride(
  arr: WalkedArray,
  override: NormalizedOverride | undefined,
  path: string,
): FieldPlan {
  if (override === undefined) return planDefaultArray(arr);
  const baseCtx = contextReasons(arr.reasons);

  switch (override.kind) {
    case 'exact':
    case 'set':
      return {
        comparator: override.kind,
        onSplit: override.onSplit ?? 'warn',
        reasons: mergeReasons(baseCtx, ['caller-override']),
        nullable: arr.nullable,
      };
    case 'none':
      return callerNonePlan(baseCtx, arr.nullable);
    case 'onSplit-only': {
      const def = planDefaultArray(arr);
      if (def.comparator === 'none') {
        throw new DissentArgumentError(
          'incompatible-override',
          path,
          `Override { onSplit } at "${path}" requires a non-none default comparator`,
        );
      }
      return {
        ...def,
        onSplit: override.onSplit,
        reasons: mergeReasons(def.reasons, ['caller-override']),
      };
    }
    case 'keyed-set': {
      if (arr.tuple || arr.items === null || arr.items.kind !== 'object') {
        throw new DissentArgumentError(
          'incompatible-override',
          path,
          `Keyed-set override at "${path}" requires an array of objects`,
        );
      }
      const key = override.key;
      if (typeof key !== 'string' || key.length === 0) {
        throw new DissentArgumentError(
          'invalid-key',
          path,
          `Keyed-set override at "${path}" requires a non-empty string key`,
        );
      }
      const keyNode = arr.items.properties.get(key);
      if (
        keyNode === undefined ||
        !arr.items.required.has(key) ||
        !isValidKeySchema(keyNode)
      ) {
        throw new DissentArgumentError(
          'invalid-key',
          path,
          `Key "${key}" at "${path}" must be a required non-nullable string, integer, enum, or const property`,
        );
      }
      const itemEntries: Array<[string, LeafPlan]> = [];
      planNestedObjectLeaves(arr.items, '', itemEntries, key);
      return {
        comparator: 'keyed-set',
        key,
        onSplit: override.onSplit ?? 'warn',
        itemFields: toSortedNullProtoRecord(itemEntries),
        reasons: mergeReasons(
          mergeReasons(baseCtx, contextReasons(arr.items.reasons)),
          ['caller-override'],
        ),
        nullable: arr.nullable,
      };
    }
    case 'tolerance':
      throw new DissentArgumentError(
        'incompatible-override',
        path,
        `Tolerance override at "${path}" requires a number or integer schema`,
      );
  }
}

function planUnionWithOverride(
  union: WalkedUnion,
  override: NormalizedOverride | undefined,
  path: string,
): FieldPlan {
  const baseCtx = contextReasons(union.reasons);

  if (override !== undefined) {
    if (override.kind === 'exact') {
      return {
        comparator: 'exact',
        onSplit: override.onSplit ?? 'warn',
        reasons: mergeReasons(baseCtx, ['caller-override']),
        nullable: union.nullable,
      };
    }
    if (override.kind === 'none') {
      return callerNonePlan(baseCtx, union.nullable);
    }
    if (override.kind !== 'onSplit-only') {
      throw new DissentArgumentError(
        'incompatible-override',
        path,
        `Override "${override.kind}" is incompatible with discriminated union at "${path}"`,
      );
    }
  }

  const branchEntries: Array<[string, Record<string, LeafPlan>]> = [];
  for (const [canonKey, branch] of union.branches) {
    const leafEntries: Array<[string, LeafPlan]> = [];
    planNestedObjectLeaves(branch.object, '', leafEntries);
    branchEntries.push([canonKey, toSortedNullProtoRecord(leafEntries)]);
  }

  return {
    comparator: 'discriminated-union',
    discriminator: union.discriminator,
    onSplit: override?.kind === 'onSplit-only' ? override.onSplit : 'critical',
    branches: toSortedNullProtoRecord(branchEntries),
    reasons:
      override?.kind === 'onSplit-only'
        ? mergeReasons(union.reasons, ['caller-override'])
        : [...union.reasons],
    nullable: union.nullable,
  };
}

function assertNoNestedOverridesUnder(
  prefix: string,
  overrides: Map<string, NormalizedOverride>,
): void {
  const slashPrefix = prefix === '' ? '/' : `${prefix}/`;
  for (const candidatePath of overrides.keys()) {
    if (candidatePath.startsWith(slashPrefix)) {
      throw new DissentArgumentError(
        'incompatible-override',
        candidatePath,
        `Override at "${candidatePath}" conflicts with parent override at "${prefix}"`,
      );
    }
  }
}

type PlanCtx = {
  overrides: Map<string, NormalizedOverride>;
  out: Array<[string, FieldPlan]>;
};

function walkPlanEntries(
  obj: WalkedObject,
  prefix: string,
  ctx: PlanCtx,
): void {
  if (obj.additionalProperties) {
    ctx.out.push([
      prefix,
      nonePlan({
        reason: 'unsupported',
        detail: 'additional-properties',
        reasons: obj.reasons,
        nullable: obj.nullable,
      }),
    ]);
  }

  for (const [propName, child] of obj.properties) {
    const childPath = appendPointer(prefix, propName);
    const override = ctx.overrides.get(childPath);

    if (child.kind === 'leaf') {
      ctx.out.push([
        childPath,
        planLeafWithOverride(child, override, childPath),
      ]);
    } else if (child.kind === 'array') {
      ctx.out.push([
        childPath,
        planArrayWithOverride(child, override, childPath),
      ]);
    } else if (child.kind === 'discriminated-union') {
      ctx.out.push([
        childPath,
        planUnionWithOverride(child, override, childPath),
      ]);
    } else if (override === undefined) {
      walkPlanEntries(child, childPath, ctx);
    } else {
      const baseCtx = contextReasons(child.reasons);
      if (override.kind === 'exact') {
        assertNoNestedOverridesUnder(childPath, ctx.overrides);
        ctx.out.push([
          childPath,
          {
            comparator: 'exact',
            onSplit: override.onSplit ?? 'warn',
            reasons: mergeReasons(baseCtx, ['caller-override']),
            nullable: child.nullable,
          },
        ]);
      } else if (override.kind === 'none') {
        assertNoNestedOverridesUnder(childPath, ctx.overrides);
        ctx.out.push([childPath, callerNonePlan(baseCtx, child.nullable)]);
      } else {
        throw new DissentArgumentError(
          'incompatible-override',
          childPath,
          `Override "${override.kind}" cannot apply to plain object at "${childPath}"`,
        );
      }
    }
  }
}

/**
 * Synchronous pure plan derivation returning sorted, null-prototype `fields`
 * keyed by RFC 6901 JSON Pointer.
 */
export function buildPlanFields<T = Record<string, unknown>>(
  rootSchema: unknown,
  compare?: CompareOverrides<T>,
): Record<string, FieldPlan> {
  const root = walkSchema(rootSchema);
  const walkedPaths = collectWalkedPaths(root);
  const overrides = new Map<string, NormalizedOverride>();

  if (compare !== undefined) {
    if (!isPlainObject(compare)) {
      throw new DissentArgumentError(
        'invalid-option',
        'compare',
        'compare must be a plain object',
      );
    }
    for (const rawKey of Object.keys(compare)) {
      const pointer = normalizePath(rawKey);
      if (overrides.has(pointer)) {
        throw new DissentArgumentError(
          'invalid-option',
          `compare.${rawKey}`,
          `Duplicate compare path "${pointer}" from key "${rawKey}"`,
        );
      }
      if (!walkedPaths.has(pointer)) {
        throw new DissentArgumentError(
          'unknown-compare-path',
          pointer,
          `Compare path "${rawKey}" (normalized "${pointer}") does not exist in schema`,
        );
      }
      const rawOverride = ownValue<ComparatorOverride>(compare, rawKey);
      if (rawOverride !== undefined) {
        overrides.set(pointer, parseOverride(rawOverride, pointer));
      }
    }
  }

  const out: Array<[string, FieldPlan]> = [];
  walkPlanEntries(root, '', { overrides, out });
  return toSortedNullProtoRecord(out);
}

/**
 * Derives the deterministic comparison plan and its `dissent-plan/1` fingerprint
 * from a resolved JSON Schema and optional caller comparator overrides.
 */
export async function derivePlan<T = Record<string, unknown>>(
  rootSchema: unknown,
  compare?: CompareOverrides<T>,
): Promise<DerivedPlan> {
  const fields = buildPlanFields(rootSchema, compare);
  const fingerprint = await sha256Hex(
    canonicalJson({ protocol: 'dissent-plan/1', fields }),
  );
  return { fingerprint, fields };
}
