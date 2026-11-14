import { isPlainObject, ownValue } from './compare/util.js';
import { sanitizeInline } from './sanitize.js';

import type { ReceiptCheck } from './types.js';

const REQUIRED_STRING_FIELDS = [
  'provider',
  'profile',
  'runtimeImageDigest',
  'networkPolicySha256',
  'receiptId',
  'region',
] as const;

/**
 * Validates an experimental offline execution environment receipt (§10.5).
 * Pure, never throws.
 *
 * @experimental Can change in a minor release until the v0.3 sandbox producer exists.
 */
export function validateOfflineReceipt(
  receipt: unknown,
  expected?: { networkPolicySha256?: string; runtimeImageDigest?: string },
): ReceiptCheck {
  if (!isPlainObject(receipt)) {
    return { valid: false, reason: 'malformed' };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!Object.hasOwn(receipt, field)) {
      return { valid: false, reason: 'malformed' };
    }
    const val = ownValue(receipt, field);
    if (typeof val !== 'string' || val === '') {
      return { valid: false, reason: 'malformed' };
    }
  }

  if (!Object.hasOwn(receipt, 'networkPolicyEnforced')) {
    return { valid: false, reason: 'malformed' };
  }
  const networkPolicyEnforced = ownValue(receipt, 'networkPolicyEnforced');
  if (typeof networkPolicyEnforced !== 'boolean') {
    return { valid: false, reason: 'malformed' };
  }

  const profile = ownValue<string>(receipt, 'profile')!;
  if (profile !== 'offline-verification-v1') {
    return { valid: false, reason: 'wrong-profile' };
  }

  if (networkPolicyEnforced !== true) {
    return { valid: false, reason: 'network-not-enforced' };
  }

  if (isPlainObject(expected)) {
    const expectedPolicy = ownValue(expected, 'networkPolicySha256');
    if (
      typeof expectedPolicy === 'string' &&
      ownValue<string>(receipt, 'networkPolicySha256') !== expectedPolicy
    ) {
      return { valid: false, reason: 'policy-mismatch' };
    }

    const expectedImage = ownValue(expected, 'runtimeImageDigest');
    if (
      typeof expectedImage === 'string' &&
      ownValue<string>(receipt, 'runtimeImageDigest') !== expectedImage
    ) {
      return { valid: false, reason: 'image-mismatch' };
    }
  }

  return { valid: true };
}

/** Extracts a sanitized receipt ID string or null from an unchecked receipt candidate. */
export function readReceiptId(receipt: unknown): string | null {
  if (!isPlainObject(receipt) || !Object.hasOwn(receipt, 'receiptId')) {
    return null;
  }
  const raw = ownValue(receipt, 'receiptId');
  if (typeof raw !== 'string') return null;
  const clean = sanitizeInline(raw);
  return clean === '' ? null : clean;
}
