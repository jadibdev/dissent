import { canonicalJson, compareUtf16 } from '../canonical/canonical-json.js';
import { DissentArgumentError } from '../errors.js';
import { appendPointer, parsePointer } from '../paths.js';

import type {
  JSONValue,
  LeafPlan,
  NotComparedDetail,
  PlanReason,
  Severity,
} from '../types.js';

import { isPlainObject, ownValue, sortLabels, sortWith } from './util.js';

export const MAX_SCHEMA_DEPTH = 16;

export type WalkedBranch = {
  value: JSONValue;
  object: WalkedObject;
};

export type WalkedObject = {
  kind: 'object';
  reasons: PlanReason[];
  nullable: boolean;
  properties: Map<string, WalkedNode>;
  required: Set<string>;
  additionalProperties: boolean;
};

export type WalkedArray = {
  kind: 'array';
  reasons: PlanReason[];
  nullable: boolean;
  items: WalkedNode | null;
  tuple: boolean;
};

export type WalkedUnion = {
  kind: 'discriminated-union';
  reasons: PlanReason[];
  nullable: boolean;
  discriminator: string;
  branches: Map<string, WalkedBranch>;
};

export type WalkedLeaf = {
  kind: 'leaf';
  plan: LeafPlan;
  primitiveType: 'boolean' | 'integer' | 'number' | 'string' | 'null' | 'other';
  isBooleanEnumConst: boolean;
  resolvedSchema?: Record<string, unknown>;
};

export type WalkedNode = WalkedLeaf | WalkedObject | WalkedArray | WalkedUnion;

type RawSchema = Record<string, unknown>;

type WalkCtx = {
  root: unknown;
  depth: number;
  refStack: Set<string>;
  reasons: PlanReason[];
  nullable: boolean;
};

const IGNORED_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$schema',
  '$id',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
  'propertyNames',
  'additionalProperties',
]);

function addReason(reasons: PlanReason[], reason: PlanReason): PlanReason[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

function withReason(ctx: WalkCtx, reason: PlanReason): WalkCtx {
  return { ...ctx, reasons: addReason(ctx.reasons, reason) };
}

function withNullable(ctx: WalkCtx): WalkCtx {
  return {
    ...ctx,
    reasons: addReason(ctx.reasons, 'nullable-unwrap'),
    nullable: true,
  };
}

function buildLeaf(
  plan: LeafPlan,
  primitiveType: WalkedLeaf['primitiveType'],
  isBooleanEnumConst: boolean,
  resolvedSchema?: RawSchema,
): WalkedLeaf {
  const leaf: WalkedLeaf = {
    kind: 'leaf',
    plan,
    primitiveType,
    isBooleanEnumConst,
  };
  if (resolvedSchema !== undefined) leaf.resolvedSchema = resolvedSchema;
  return leaf;
}

function makeUnsupported(
  ctx: Pick<WalkCtx, 'reasons' | 'nullable'>,
  detail: NotComparedDetail,
  resolvedSchema?: RawSchema,
): WalkedLeaf {
  return buildLeaf(
    {
      comparator: 'none',
      reason: 'unsupported',
      detail,
      reasons: addReason(ctx.reasons, 'unsupported'),
      nullable: ctx.nullable,
    },
    'other',
    false,
    resolvedSchema,
  );
}

function makePolicy(
  ctx: Pick<WalkCtx, 'reasons' | 'nullable'>,
  detail: NotComparedDetail,
  primitiveType: WalkedLeaf['primitiveType'],
  resolvedSchema?: RawSchema,
): WalkedLeaf {
  return buildLeaf(
    {
      comparator: 'none',
      reason: 'policy',
      detail,
      reasons: addReason(ctx.reasons, 'policy'),
      nullable: ctx.nullable,
    },
    primitiveType,
    false,
    resolvedSchema,
  );
}

function makeExact(
  ctx: Pick<WalkCtx, 'reasons' | 'nullable'>,
  opts: {
    onSplit: Severity;
    primitiveType: WalkedLeaf['primitiveType'];
    isBooleanEnumConst?: boolean;
    resolvedSchema?: RawSchema;
  },
): WalkedLeaf {
  return buildLeaf(
    {
      comparator: 'exact',
      onSplit: opts.onSplit,
      reasons: addReason(ctx.reasons, 'default-by-type'),
      nullable: ctx.nullable,
    },
    opts.primitiveType,
    opts.isBooleanEnumConst ?? false,
    opts.resolvedSchema,
  );
}

function resolvePointerInRoot(
  root: unknown,
  ref: string,
):
  | { ok: true; target: unknown }
  | { ok: false; detail: 'external-ref' | 'invalid-ref' } {
  if (!ref.startsWith('#')) return { ok: false, detail: 'external-ref' };
  if (ref === '#') return { ok: true, target: root };
  if (!ref.startsWith('#/')) return { ok: false, detail: 'invalid-ref' };

  let tokens: string[];
  try {
    tokens = parsePointer(ref.slice(1));
  } catch {
    return { ok: false, detail: 'invalid-ref' };
  }

  let curr: unknown = root;
  for (const token of tokens) {
    if (curr === null || typeof curr !== 'object') {
      return { ok: false, detail: 'invalid-ref' };
    }
    if (Array.isArray(curr)) {
      const idx = Number(token);
      if (
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= curr.length ||
        !Object.hasOwn(curr, idx)
      ) {
        return { ok: false, detail: 'invalid-ref' };
      }
      curr = curr[idx];
    } else {
      if (!Object.hasOwn(curr, token)) {
        return { ok: false, detail: 'invalid-ref' };
      }
      curr = ownValue(curr, token);
    }
  }
  if (typeof curr !== 'boolean' && !isPlainObject(curr)) {
    return { ok: false, detail: 'invalid-ref' };
  }
  return { ok: true, target: curr };
}

function resolveSimpleRef(
  node: unknown,
  ctx: Pick<WalkCtx, 'root' | 'depth' | 'refStack'>,
):
  | { ok: true; schema: unknown; depth: number; refStack: Set<string> }
  | { ok: false; detail: NotComparedDetail } {
  let curr = node;
  let depth = ctx.depth;
  const refStack = new Set(ctx.refStack);
  while (isPlainObject(curr) && typeof curr.$ref === 'string') {
    if (refStack.has(curr.$ref)) {
      return { ok: false, detail: 'ref-cycle' };
    }
    const res = resolvePointerInRoot(ctx.root, curr.$ref);
    if (!res.ok) return res;
    depth++;
    if (depth > MAX_SCHEMA_DEPTH) {
      return { ok: false, detail: 'depth-exceeded' };
    }
    refStack.add(curr.$ref);
    curr = res.target;
  }
  return { ok: true, schema: curr, depth, refStack };
}

function isNullSchema(
  node: unknown,
  ctx: Pick<WalkCtx, 'root' | 'depth' | 'refStack'>,
): boolean {
  const res = resolveSimpleRef(node, ctx);
  if (!res.ok || !isPlainObject(res.schema)) return false;
  const s = res.schema;
  if (s.type !== 'null') return false;
  for (const key of [
    'properties',
    'items',
    'prefixItems',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'if',
    'enum',
    'const',
  ]) {
    if (Object.hasOwn(s, key)) return false;
  }
  return true;
}

function extractLiteral(
  propSchema: unknown,
  ctx: Pick<WalkCtx, 'root' | 'depth' | 'refStack'>,
): { ok: true; value: JSONValue } | { ok: false } {
  const resolved = resolveSimpleRef(propSchema, ctx);
  if (!resolved.ok || !isPlainObject(resolved.schema)) return { ok: false };
  const s = resolved.schema;

  // Reject combinators / complex constraints on the discriminator property itself.
  for (const key of Object.keys(s)) {
    if (
      key === 'type' ||
      key === 'const' ||
      key === 'enum' ||
      IGNORED_KEYWORDS.has(key)
    ) {
      continue;
    }
    return { ok: false };
  }

  let candidate: unknown;
  if (Object.hasOwn(s, 'const') && s.const !== undefined) {
    if (Array.isArray(s.enum)) {
      if (s.enum.length !== 1) return { ok: false };
      try {
        if (canonicalJson(s.enum[0]) !== canonicalJson(s.const)) {
          return { ok: false };
        }
      } catch {
        return { ok: false };
      }
    }
    candidate = s.const;
  } else if (Array.isArray(s.enum) && s.enum.length === 1) {
    candidate = s.enum[0];
  } else {
    return { ok: false };
  }

  try {
    canonicalJson(candidate);
    return { ok: true, value: candidate as JSONValue };
  } catch {
    return { ok: false };
  }
}

export function walkSchema(rootSchema: unknown): WalkedObject {
  let rootNode: unknown = rootSchema;
  let depth = 0;
  const refStack = new Set<string>();
  let reasons: PlanReason[] = [];

  while (isPlainObject(rootNode) && typeof rootNode.$ref === 'string') {
    if (refStack.has(rootNode.$ref)) {
      throw new DissentArgumentError('schema-root-not-object', 'schema');
    }
    const res = resolvePointerInRoot(rootSchema, rootNode.$ref);
    if (!res.ok || ++depth > MAX_SCHEMA_DEPTH) {
      throw new DissentArgumentError('schema-root-not-object', 'schema');
    }
    refStack.add(rootNode.$ref);
    reasons = addReason(reasons, 'ref-resolved');
    rootNode = res.target;
  }

  if (
    !isPlainObject(rootNode) ||
    rootNode.type !== 'object' ||
    !isPlainObject(rootNode.properties)
  ) {
    throw new DissentArgumentError('schema-root-not-object', 'schema');
  }

  return walkObject(rootNode, {
    root: rootSchema,
    depth,
    refStack,
    reasons,
    nullable: false,
  });
}

function walkUnionNode(
  unionBranchesRaw: unknown[],
  node: RawSchema,
  ctx: WalkCtx,
): WalkedNode {
  const nonNullBranches = unionBranchesRaw.filter(b => !isNullSchema(b, ctx));
  const hadNullBranch = nonNullBranches.length < unionBranchesRaw.length;
  const nextCtx = hadNullBranch ? withNullable(ctx) : ctx;

  if (nonNullBranches.length === 0) {
    return makeExact(
      { ...nextCtx, nullable: true },
      { onSplit: 'warn', primitiveType: 'null', resolvedSchema: node },
    );
  }
  if (nonNullBranches.length === 1) {
    return walkNode(nonNullBranches[0], nextCtx);
  }
  return walkUnion(nonNullBranches, node, nextCtx);
}

function walkNode(node: unknown, ctx: WalkCtx): WalkedNode {
  // Rule 1: Local $ref
  if (isPlainObject(node) && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ctx.refStack.has(ref)) {
      return makeUnsupported(ctx, 'ref-cycle', node);
    }
    const resolved = resolvePointerInRoot(ctx.root, ref);
    if (!resolved.ok) {
      return makeUnsupported(ctx, resolved.detail, node);
    }
    const nextDepth = ctx.depth + 1;
    if (nextDepth > MAX_SCHEMA_DEPTH) {
      return makeUnsupported(ctx, 'depth-exceeded', node);
    }
    const nextRefs = new Set(ctx.refStack);
    nextRefs.add(ref);
    return walkNode(resolved.target, {
      ...withReason(ctx, 'ref-resolved'),
      depth: nextDepth,
      refStack: nextRefs,
    });
  }

  // Rule 2: Depth check
  if (ctx.depth > MAX_SCHEMA_DEPTH) {
    return makeUnsupported(
      ctx,
      'depth-exceeded',
      isPlainObject(node) ? node : undefined,
    );
  }

  if (typeof node === 'boolean' || !isPlainObject(node)) {
    return makeUnsupported(ctx, 'untyped');
  }

  // Rule 3: Nullable unwrap
  if (Array.isArray(node.type)) {
    const types = node.type;
    if (types.includes('null')) {
      const nonNull = types.filter(t => t !== 'null');
      const unwrappedCtx = withNullable(ctx);
      if (nonNull.length === 0) {
        return walkNode({ ...node, type: 'null' }, unwrappedCtx);
      }
      if (nonNull.length === 1) {
        return walkNode({ ...node, type: nonNull[0] }, unwrappedCtx);
      }
      return makeUnsupported(unwrappedCtx, 'multi-type', node);
    }
    if (types.length === 1) {
      return walkNode({ ...node, type: types[0] }, ctx);
    }
    return makeUnsupported(
      ctx,
      types.length > 1 ? 'multi-type' : 'untyped',
      node,
    );
  }

  const hasAnyOf = Array.isArray(node.anyOf);
  const hasOneOf = Array.isArray(node.oneOf);
  if (hasAnyOf && hasOneOf) {
    return makeUnsupported(ctx, 'union', node);
  }
  const unionBranchesRaw = hasAnyOf
    ? (node.anyOf as unknown[])
    : hasOneOf
      ? (node.oneOf as unknown[])
      : null;

  if (unionBranchesRaw !== null) {
    return walkUnionNode(unionBranchesRaw, node, ctx);
  }

  // Rule 5: Combinators
  if (Array.isArray(node.allOf)) {
    return makeUnsupported(ctx, 'all-of', node);
  }
  if (
    Object.hasOwn(node, 'if') ||
    Object.hasOwn(node, 'then') ||
    Object.hasOwn(node, 'else')
  ) {
    return makeUnsupported(ctx, 'conditional', node);
  }
  if (Object.hasOwn(node, 'not')) {
    return makeUnsupported(ctx, 'not', node);
  }

  // Rule 6: enum or const
  if (
    (Object.hasOwn(node, 'const') && node.const !== undefined) ||
    Array.isArray(node.enum)
  ) {
    const primType =
      node.type === 'integer' ||
      node.type === 'number' ||
      node.type === 'string' ||
      node.type === 'boolean' ||
      node.type === 'null'
        ? node.type
        : 'other';
    return makeExact(ctx, {
      onSplit: 'critical',
      primitiveType: primType,
      isBooleanEnumConst: true,
      resolvedSchema: node,
    });
  }

  // Rule 7: type
  if (typeof node.type === 'string') {
    switch (node.type) {
      case 'boolean':
        return makeExact(ctx, {
          onSplit: 'critical',
          primitiveType: 'boolean',
          isBooleanEnumConst: true,
          resolvedSchema: node,
        });
      case 'integer':
        return makeExact(ctx, {
          onSplit: 'warn',
          primitiveType: 'integer',
          resolvedSchema: node,
        });
      case 'null':
        return makeExact(ctx, {
          onSplit: 'warn',
          primitiveType: 'null',
          resolvedSchema: node,
        });
      case 'number':
        return makePolicy(ctx, 'number-without-tolerance', 'number', node);
      case 'string':
        return makePolicy(ctx, 'free-text', 'string', node);
      case 'object':
        return walkObjectOrRecord(node, ctx);
      case 'array':
        return walkArray(node, ctx);
      default:
        return makeUnsupported(ctx, 'untyped', node);
    }
  }

  // Rule 8: Untyped
  return makeUnsupported(ctx, 'untyped', node);
}

function walkUnion(
  nonNullBranches: unknown[],
  rawUnion: RawSchema,
  ctx: WalkCtx,
): WalkedNode {
  const branchEntries: Array<{
    schema: RawSchema;
    ctx: Pick<WalkCtx, 'root' | 'depth' | 'refStack'>;
  }> = [];

  for (const branch of nonNullBranches) {
    const res = resolveSimpleRef(branch, {
      root: ctx.root,
      depth: ctx.depth + 1,
      refStack: ctx.refStack,
    });
    if (!res.ok) {
      return makeUnsupported(
        ctx,
        res.detail === 'depth-exceeded' ? 'depth-exceeded' : 'union',
        rawUnion,
      );
    }
    if (
      !isPlainObject(res.schema) ||
      res.schema.type !== 'object' ||
      !isPlainObject(res.schema.properties)
    ) {
      return makeUnsupported(ctx, 'union', rawUnion);
    }
    if (
      Array.isArray(res.schema.allOf) ||
      Array.isArray(res.schema.anyOf) ||
      Array.isArray(res.schema.oneOf) ||
      Object.hasOwn(res.schema, 'if') ||
      Object.hasOwn(res.schema, 'not')
    ) {
      return makeUnsupported(ctx, 'union', rawUnion);
    }
    branchEntries.push({
      schema: res.schema,
      ctx: { root: ctx.root, depth: res.depth, refStack: res.refStack },
    });
  }

  const firstBranch = branchEntries[0]!.schema;
  const firstProps = firstBranch.properties as RawSchema;
  const firstRequired = Array.isArray(firstBranch.required)
    ? new Set(
        firstBranch.required.filter((x): x is string => typeof x === 'string'),
      )
    : new Set<string>();

  const candidates = sortLabels(
    Object.keys(firstProps).filter(name => firstRequired.has(name)),
  );

  let chosenDiscriminator: string | null = null;
  let chosenValues: Array<{ key: string; value: JSONValue }> = [];

  for (const propName of candidates) {
    const seenKeys = new Set<string>();
    const values: Array<{ key: string; value: JSONValue }> = [];
    let valid = true;

    for (const branch of branchEntries) {
      const bProps = branch.schema.properties as RawSchema;
      const bReq = Array.isArray(branch.schema.required)
        ? branch.schema.required
        : [];
      if (!Object.hasOwn(bProps, propName) || !bReq.includes(propName)) {
        valid = false;
        break;
      }
      const lit = extractLiteral(bProps[propName], branch.ctx);
      if (!lit.ok) {
        valid = false;
        break;
      }
      const canonical = canonicalJson(lit.value);
      if (seenKeys.has(canonical)) {
        valid = false;
        break;
      }
      seenKeys.add(canonical);
      values.push({ key: canonical, value: lit.value });
    }

    if (valid) {
      chosenDiscriminator = propName;
      chosenValues = values;
      break;
    }
  }

  if (chosenDiscriminator === null) {
    return makeUnsupported(ctx, 'union', rawUnion);
  }

  const indexed = sortWith(
    chosenValues.map((cv, idx) => ({ ...cv, idx })),
    (a, b) => compareUtf16(a.key, b.key),
  );

  const branches = new Map<string, WalkedBranch>();
  for (const entry of indexed) {
    const branch = branchEntries[entry.idx]!;
    const walkedObj = walkObject(
      branch.schema,
      { ...branch.ctx, reasons: [], nullable: false },
      chosenDiscriminator,
    );
    branches.set(entry.key, { value: entry.value, object: walkedObj });
  }

  return {
    kind: 'discriminated-union',
    reasons: addReason(ctx.reasons, 'discriminated-union'),
    nullable: ctx.nullable,
    discriminator: chosenDiscriminator,
    branches,
  };
}

function walkObjectOrRecord(node: RawSchema, ctx: WalkCtx): WalkedNode {
  if (
    !isPlainObject(node.properties) ||
    Object.keys(node.properties).length === 0
  ) {
    return makeUnsupported(ctx, 'record', node);
  }
  return walkObject(node, ctx);
}

function walkObject(
  node: RawSchema,
  ctx: WalkCtx,
  excludeProperty?: string,
): WalkedObject {
  const propsObj = node.properties as RawSchema;
  const propNames = sortLabels(
    Object.keys(propsObj).filter(name => name !== excludeProperty),
  );

  // Carry ancestor ref-resolved into flattened properties so $ref-wrapped objects record it.
  const childReasons: PlanReason[] = ctx.reasons.includes('ref-resolved')
    ? ['ref-resolved']
    : [];
  const childCtx: WalkCtx = {
    root: ctx.root,
    depth: ctx.depth + 1,
    refStack: ctx.refStack,
    reasons: childReasons,
    nullable: false,
  };

  const properties = new Map<string, WalkedNode>();
  for (const propName of propNames) {
    properties.set(propName, walkNode(ownValue(propsObj, propName), childCtx));
  }

  const required = new Set<string>();
  if (Array.isArray(node.required)) {
    for (const r of node.required) {
      if (typeof r === 'string') required.add(r);
    }
  }

  const hasExtraProps =
    Object.hasOwn(node, 'additionalProperties') &&
    node.additionalProperties !== undefined &&
    node.additionalProperties !== false;

  return {
    kind: 'object',
    reasons: ctx.reasons,
    nullable: ctx.nullable,
    properties,
    required,
    additionalProperties: hasExtraProps,
  };
}

function walkArray(node: RawSchema, ctx: WalkCtx): WalkedNode {
  if (Array.isArray(node.prefixItems) || Array.isArray(node.items)) {
    return {
      kind: 'array',
      reasons: ctx.reasons,
      nullable: ctx.nullable,
      items: null,
      tuple: true,
    };
  }

  if (!Object.hasOwn(node, 'items') || node.items === undefined) {
    return {
      kind: 'array',
      reasons: ctx.reasons,
      nullable: ctx.nullable,
      items: makeUnsupported({ reasons: [], nullable: false }, 'untyped'),
      tuple: false,
    };
  }

  const walkedItem = walkNode(node.items, {
    root: ctx.root,
    depth: ctx.depth + 1,
    refStack: ctx.refStack,
    reasons: [],
    nullable: false,
  });
  return {
    kind: 'array',
    reasons: ctx.reasons,
    nullable: ctx.nullable,
    items: walkedItem,
    tuple: false,
  };
}

/** Resolves a walkable node's raw schema for `{ key }` primitive validation in `derivePlan`. */
export function isValidKeySchema(node: WalkedNode): boolean {
  if (node.kind !== 'leaf') return false;
  if (node.plan.nullable) return false;
  if (node.primitiveType === 'string' || node.primitiveType === 'integer') {
    return true;
  }
  if (node.resolvedSchema !== undefined) {
    return (
      Array.isArray(node.resolvedSchema.enum) ||
      (Object.hasOwn(node.resolvedSchema, 'const') &&
        node.resolvedSchema.const !== undefined)
    );
  }
  return false;
}

/** Collects flattened pointer paths under an object (used for validation and debugging). */
export function collectWalkedPaths(
  obj: WalkedObject,
  prefix = '',
  out: Map<string, WalkedNode> = new Map(),
): Map<string, WalkedNode> {
  for (const [name, child] of obj.properties) {
    const path = appendPointer(prefix, name);
    out.set(path, child);
    if (child.kind === 'object') {
      collectWalkedPaths(child, path, out);
    }
  }
  return out;
}
