// Test-only independent predicate translation of §5.4. Does not call engine/rules/schema.
import type { BudgetSnapshot, CategoryMap, EnforcementCatalogue, MandatePolicy } from '../../shared/types.ts';
// Line-local predicate: cart-level status/shape/step-up failures do not turn a
// valid line into an invalid one. Kept independent of schemas, engine and money.
export function oracleLineAllows(policy: MandatePolicy, prices: EnforcementCatalogue, categories: CategoryMap, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const line = raw as Record<string, unknown>;
  if (Object.keys(line).sort().join(',') !== 'qty,sku' || typeof line['sku'] !== 'string' || !line['sku'].length || line['sku'].length > 128 || typeof line['qty'] !== 'number') return false;
  const sku = line['sku']; const qty = line['qty'];
  if (!Object.hasOwn(prices, sku) || !Object.hasOwn(categories, sku)) return false;
  const price = prices[sku]!; const category = categories[sku]!;
  if (price.currency !== policy.currency || policy.deniedSkus.includes(sku) || policy.deniedCategories.includes(category) || !policy.allowedCategories.includes(category)) return false;
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > policy.maxQuantityPerLine || !Number.isSafeInteger(price.unitPriceMinor) || price.unitPriceMinor <= 0 || price.unitPriceMinor > 1_000_000_000_000) return false;
  return BigInt(price.unitPriceMinor) * BigInt(qty) <= BigInt(policy.perLineMaxMinor);
}
export function oracleAllows(policy: MandatePolicy, prices: EnforcementCatalogue, categories: CategoryMap, raw: unknown, budget: BudgetSnapshot, now: number, confirmed: boolean): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const cart = raw as Record<string, unknown>;
  if (Object.keys(cart).sort().join(',') !== 'lines,mandateId,proposalId,source' || typeof cart['proposalId'] !== 'string' || cart['proposalId'].length < 1 || cart['proposalId'].length > 128 || cart['mandateId'] !== policy.mandateId) return false;
  const source = cart['source'];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const s = source as Record<string, unknown>;
  if (s['kind'] === 'owner') { if (Object.keys(s).join(',') !== 'kind') return false; }
  else if (s['kind'] !== 'agent' || Object.keys(s).sort().join(',') !== 'kind,mode,model' || !['fixture','local','hosted'].includes(s['mode'] as string) || typeof s['model'] !== 'string' || !s['model'].length || s['model'].length > 128) return false;
  const expiry = Date.parse(policy.expiresAt);
  if (policy.status !== 'ACTIVE' || !policy.contentHash || budget.spendBlocked || !Number.isFinite(now) || !Number.isFinite(expiry) || now >= expiry || policy.merchantId !== 'demo-merchant') return false;
  const lines = cart['lines'];
  if (!Array.isArray(lines) || !lines.length || lines.length > policy.maxLinesPerCart) return false;
  const seen = new Set<string>(); let total = 500n;
  for (const rawLine of lines) {
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) return false;
    const line = rawLine as Record<string, unknown>;
    if (Object.keys(line).sort().join(',') !== 'qty,sku' || typeof line['sku'] !== 'string' || !line['sku'].length || line['sku'].length > 128 || typeof line['qty'] !== 'number') return false;
    const sku = line['sku']; const qty = line['qty'];
    if (seen.has(sku)) return false; seen.add(sku);
    if (!Object.hasOwn(prices, sku) || !Object.hasOwn(categories, sku)) return false;
    const price = prices[sku]!; const category = categories[sku]!;
    if (price.currency !== policy.currency || policy.deniedSkus.includes(sku) || policy.deniedCategories.includes(category) || !policy.allowedCategories.includes(category)) return false;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > policy.maxQuantityPerLine || !Number.isSafeInteger(price.unitPriceMinor) || price.unitPriceMinor <= 0 || price.unitPriceMinor > 1_000_000_000_000) return false;
    const amount = BigInt(price.unitPriceMinor) * BigInt(qty);
    if (amount < 0 || amount > BigInt(policy.perLineMaxMinor)) return false;
    total += amount;
  }
  return total <= BigInt(policy.perOrderMaxMinor) && total <= BigInt(budget.availableMinor) && (total < BigInt(policy.stepUpThresholdMinor) || confirmed);
}
