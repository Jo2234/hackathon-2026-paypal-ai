import type { BudgetSnapshot, CartVerdict, CategoryMap, EnforcementCatalogue, LineVerdict, MandatePolicy, RuleId } from '../../shared/types.ts';
import { proposalSchema } from '../../shared/schemas.ts';
import { addMinor, multiplyMinor } from '../money.ts';
import { orderedRules } from './rules.ts';
export function evaluateCart(policy: MandatePolicy, catalogue: EnforcementCatalogue, map: CategoryMap, input: unknown, budget: BudgetSnapshot, now: number, stepUpConfirmed:boolean, merchantId: string): CartVerdict {
  const parsed = proposalSchema.safeParse(input);
  const failures: RuleId[] = [];
  if (!parsed.success) return { proposalId: '', policyVersion: policy.version, policyHash: policy.contentHash || '', ok: false, stepUpRequired: false, lines: [], ruleIds: ['R16_SCHEMA'], itemTotalMinor: null, shippingMinor: 500, orderTotalMinor: null };
  const proposal = parsed.data;
  if (proposal.lines.length < 1 || proposal.lines.length > policy.maxLinesPerCart) failures.push('R14_CART_SHAPE');
  if (new Set(proposal.lines.map(line => line.sku)).size !== proposal.lines.length) failures.push('R15_DUPLICATE_SKU');
  if (policy.status !== 'ACTIVE' || budget.spendBlocked || !policy.contentHash || proposal.mandateId !== policy.mandateId) failures.push('R01_MANDATE_NOT_ACTIVE');
  const expiresAt = Date.parse(policy.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) failures.push('R02_MANDATE_EXPIRED');
  if (policy.merchantId !== merchantId) failures.push('R13_MERCHANT');
  const lines: LineVerdict[] = proposal.lines.map(line => {
    const item = Object.hasOwn(catalogue, line.sku) ? catalogue[line.sku] : undefined;
    const category = Object.hasOwn(map, line.sku) ? map[line.sku] ?? null : null;
    const rules: RuleId[] = []; const clauses: string[] = [];
    if (!item || category === null) rules.push('R04_UNKNOWN_SKU');
    if (item && item.currency !== policy.currency) rules.push('R03_CURRENCY');
    if (policy.deniedSkus.includes(line.sku)) rules.push('R07_SKU_DENIED');
    if (category && policy.deniedCategories.includes(category)) rules.push('R05_CATEGORY_DENIED');
    if (category && !policy.allowedCategories.includes(category)) rules.push('R06_CATEGORY_NOT_ALLOWED');
    else if (category) clauses.push(`category ${category} ∈ allowed`);
    const validQty = Number.isSafeInteger(line.qty) && line.qty >= 1 && line.qty <= policy.maxQuantityPerLine;
    if (!validQty) rules.push('R08_QTY'); else clauses.push('quantity within signed limit');
    let total: number | null = null;
    if (item && validQty) {
      try {
        if (item.unitPriceMinor <= 0) throw new Error('CATALOGUE_PRICE');
        total = multiplyMinor(item.unitPriceMinor, line.qty);
      }
      catch { rules.push('R09_LINE_MAX'); }
      if (total !== null && total > policy.perLineMaxMinor) rules.push('R09_LINE_MAX');
      else if (total !== null) clauses.push('line total within signed limit');
    }
    failures.push(...rules);
    return { sku: line.sku, qty: line.qty, categoryId: category, lineTotalMinor: total, ok: rules.length === 0, ruleIds: orderedRules(rules), satisfiedClauses: clauses };
  });
  let itemTotal: number | null = null; let total: number | null = null;
  if (lines.every(line => line.lineTotalMinor !== null)) {
    try { itemTotal = addMinor(...lines.map(line => line.lineTotalMinor!)); total = addMinor(itemTotal, 500); }
    catch { failures.push('R10_ORDER_MAX'); }
  }
  if (total !== null && total > policy.perOrderMaxMinor) failures.push('R10_ORDER_MAX');
  if (total !== null && total > budget.availableMinor) failures.push('R11_INSUFFICIENT_ALLOWANCE');
  const stepUpRequired = total !== null && total >= policy.stepUpThresholdMinor;
  if (stepUpRequired && !stepUpConfirmed) failures.push('R12_STEP_UP_REQUIRED');
  const ruleIds = orderedRules(failures);
  return { proposalId: proposal.proposalId, policyVersion: policy.version, policyHash: policy.contentHash || '', ok: ruleIds.length === 0, stepUpRequired, lines, ruleIds, itemTotalMinor: itemTotal, shippingMinor: 500, orderTotalMinor: total };
}
