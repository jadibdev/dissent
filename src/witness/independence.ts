import { compareUtf16 } from '../canonical/canonical-json.js';
import { sortWith } from '../compare/util.js';
import { hasNonEmptySlashParts } from './normalize-witnesses.js';

import type {
  Finding,
  Independence,
  ModelIdentity,
  WitnessRecord,
} from '../types.js';

export type AuthorMatch = {
  authorModel: string;
  on: 'requested' | 'served';
};

function identityMatchesAuthor(
  identity: ModelIdentity,
  authorModel: string,
): boolean {
  if (identity.canonicalId === authorModel) {
    return true;
  }
  return (
    hasNonEmptySlashParts(identity.modelId) &&
    identity.modelId.toLowerCase() === authorModel
  );
}

/**
 * Matches a witness against sorted normalized `authorModels` (§8.2).
 * `requested` takes priority over `served`; earliest UTF-16 author model wins ties.
 */
export function matchAuthorModel(
  requested: ModelIdentity,
  served: ModelIdentity | null,
  sortedAuthorModels: readonly string[],
): AuthorMatch | null {
  for (const authorModel of sortedAuthorModels) {
    if (identityMatchesAuthor(requested, authorModel)) {
      return { authorModel, on: 'requested' };
    }
  }
  if (served !== null) {
    for (const authorModel of sortedAuthorModels) {
      if (identityMatchesAuthor(served, authorModel)) {
        return { authorModel, on: 'served' };
      }
    }
  }
  return null;
}

/**
 * Computes the §8.4 `Independence` block and the Layer A witness/independence findings (§9.1).
 * Expects `entries` ordered by UTF-16 sorted label.
 */
export function analyzeIndependence<T, W extends string>(
  entries: ReadonlyArray<{ label: W; record: WitnessRecord<T> }>,
  sortedAuthorModels: readonly string[],
): {
  independence: Independence<W>;
  witnessFindings: Finding<W>[];
} {
  const providerGroups = new Map<string, W[]>();
  const servedGroups = new Map<string, W[]>();
  const selfGradingWitnesses: Independence<W>['selfGradingWitnesses'] = [];
  const excludedWitnesses: Independence<W>['excludedWitnesses'] = [];
  const witnessFindings: Finding<W>[] = [];

  let asked = 0;

  for (const { label, record } of entries) {
    const excludedBefore =
      record.status === 'excluded' && record.stage === 'before-dispatch';

    if (!excludedBefore) {
      asked++;
      const pk = record.requested.providerKey;
      const group = providerGroups.get(pk);
      if (group === undefined) {
        providerGroups.set(pk, [label]);
      } else {
        group.push(label);
      }
    }

    if (record.status === 'answered' && record.served !== null) {
      const cid = record.served.canonicalId;
      const group = servedGroups.get(cid);
      if (group === undefined) {
        servedGroups.set(cid, [label]);
      } else {
        group.push(label);
      }
    }

    const servedForMatch =
      record.status === 'excluded' && record.stage === 'before-dispatch'
        ? null
        : record.served;
    const match = matchAuthorModel(
      record.requested,
      servedForMatch,
      sortedAuthorModels,
    );
    if (match !== null) {
      selfGradingWitnesses.push({
        witness: label,
        authorModel: match.authorModel,
        on: match.on,
      });
      if (record.status === 'answered') {
        witnessFindings.push({
          code: 'self-grading',
          severity: 'warn',
          witnesses: [label],
          data: { authorModel: match.authorModel, on: match.on },
        });
      }
    }

    if (record.status === 'excluded') {
      excludedWitnesses.push({
        witness: label,
        stage: record.stage,
        authorModel: record.match.authorModel,
        on: record.match.on,
      });
      witnessFindings.push({
        code: 'witness-excluded',
        severity: 'info',
        witnesses: [label],
        data: {
          stage: record.stage,
          authorModel: record.match.authorModel,
          on: record.match.on,
        },
      });
    } else if (record.status === 'failed') {
      witnessFindings.push({
        code: 'witness-failed',
        severity: 'warn',
        witnesses: [label],
        data: { kind: record.error.kind },
      });
    } else if (record.finishReason === 'length') {
      witnessFindings.push({
        code: 'truncated-output',
        severity: 'info',
        witnesses: [label],
      });
    }
  }

  const duplicateServedModels = sortWith(
    Array.from(servedGroups.entries())
      .filter(([, labels]) => labels.length >= 2)
      .map(([canonicalId, witnesses]) => ({ canonicalId, witnesses })),
    (a, b) => compareUtf16(a.canonicalId, b.canonicalId),
  );

  for (const group of duplicateServedModels) {
    witnessFindings.push({
      code: 'duplicate-served-model',
      severity: 'warn',
      witnesses: [...group.witnesses],
      data: { canonicalId: group.canonicalId },
    });
  }

  const sameProviderGroups = sortWith(
    Array.from(providerGroups.entries())
      .filter(([, labels]) => labels.length >= 2)
      .map(([providerKey, witnesses]) => ({ providerKey, witnesses })),
    (a, b) => compareUtf16(a.providerKey, b.providerKey),
  );

  const uniqueRequestedProviders = providerGroups.size;
  if (asked >= 2 && uniqueRequestedProviders === 1) {
    const onlyProviderKey = providerGroups.keys().next().value;
    if (onlyProviderKey !== undefined && onlyProviderKey !== '(default)') {
      witnessFindings.push({
        code: 'single-provider',
        severity: 'warn',
        data: { providerKey: onlyProviderKey },
      });
    }
  }

  return {
    independence: {
      uniqueRequestedProviders,
      duplicateServedModels,
      sameProviderGroups,
      selfGradingWitnesses,
      excludedWitnesses,
    },
    witnessFindings,
  };
}
