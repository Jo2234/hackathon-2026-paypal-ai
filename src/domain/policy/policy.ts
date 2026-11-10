import type { CategoryMap, MandateDraft, MandatePolicy, OwnerReview, SignedMandate } from '../../shared/types.ts';
import { ownerReviewSchema, policySchema } from '../../shared/schemas.ts';
import { hashJson } from '../../shared/canonical.ts';
export function enforcementFields(policy: MandatePolicy): Record<string, unknown> {
  const { status: _status, sourceText: _text, compiledBy: _compiler, signedAt: _signed, contentHash: _hash, ...fields } = policy;
  return { ...fields, allowedCategories: [...fields.allowedCategories].sort(), deniedCategories: [...fields.deniedCategories].sort(), deniedSkus: [...fields.deniedSkus].sort() };
}
export function policyHash(policy: MandatePolicy): string { return hashJson(enforcementFields(policy)); }
export function validatePolicy(input: unknown, map: CategoryMap, signingAt: number): MandatePolicy {
  const policy = policySchema.parse(input);
  if (!Number.isSafeInteger(signingAt)) throw new Error('SIGN_TIME');
  if (policy.perLineMaxMinor > policy.perOrderMaxMinor || policy.perOrderMaxMinor > policy.allowanceMinor || policy.stepUpThresholdMinor > policy.perOrderMaxMinor) throw new Error('POLICY_LIMIT_ORDER');
  for (const list of [policy.allowedCategories, policy.deniedCategories, policy.deniedSkus]) if (new Set(list).size !== list.length) throw new Error('POLICY_DUPLICATE');
  if (policy.allowedCategories.some(category => policy.deniedCategories.includes(category))) throw new Error('POLICY_CATEGORY_OVERLAP');
  if (policy.deniedSkus.some(sku => !Object.hasOwn(map, sku))) throw new Error('POLICY_UNKNOWN_SKU');
  const expiry = Date.parse(policy.expiresAt);
  if (expiry <= signingAt || expiry > signingAt + 90 * 86400000) throw new Error('POLICY_EXPIRY');
  return policy;
}
export function signReviewedDraft(input: unknown, reviewInput: OwnerReview, map: CategoryMap, now: number, currentHash: string | null, nextVersion: number): SignedMandate {
  const review = ownerReviewSchema.parse(reviewInput);
  const draft = validatePolicy(input, map, now);
  if (draft.status !== 'DRAFT' || draft.contentHash !== null || draft.signedAt !== null) throw new Error('DRAFT_REQUIRED');
  if (review.expectedCurrentHash !== currentHash) throw new Error('STALE_POLICY');
  for (const category of ['gift_cards','alcohol'] as const) if (draft.allowedCategories.includes(category) && !review.explicitlyAllowedSensitive.includes(category)) throw new Error('SENSITIVE_OWNER_TICK_REQUIRED');
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) throw new Error('VERSION');
  const signed = { ...draft, version: nextVersion, status: 'ACTIVE' as const, signedAt: new Date(now).toISOString(), contentHash: '' };
  return Object.freeze({ ...signed, contentHash: policyHash(signed) });
}
export function safeDefaults(ownerId: string, mandateId: string, now: number): MandateDraft {
  return { policyVersion: 1, ownerId, mandateId, version: 1, status: 'DRAFT', currency: 'USD', period: { kind: 'weekly', timezone: 'Asia/Singapore', weekStartsOn: 1 }, allowanceMinor: 8000, perOrderMaxMinor: 8000, perLineMaxMinor: 3000, stepUpThresholdMinor: 3000, allowedCategories: ['coffee_tea','printer_supplies'], deniedCategories: ['gift_cards','alcohol'], deniedSkus: [], maxQuantityPerLine: 5, maxLinesPerCart: 10, expiresAt: new Date(now + 30 * 86400000).toISOString(), refundRestoration: 'never_restore', merchantId: 'demo-merchant', sourceText: '', compiledBy: { mode: 'manual' }, signedAt: null, contentHash: null };
}
