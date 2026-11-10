import type { RuleId } from '../../shared/types.ts';
export const EVALUATION_ORDER: readonly RuleId[] = ['R16_SCHEMA','R14_CART_SHAPE','R15_DUPLICATE_SKU','R01_MANDATE_NOT_ACTIVE','R02_MANDATE_EXPIRED','R13_MERCHANT','R03_CURRENCY','R04_UNKNOWN_SKU','R07_SKU_DENIED','R05_CATEGORY_DENIED','R06_CATEGORY_NOT_ALLOWED','R08_QTY','R09_LINE_MAX','R10_ORDER_MAX','R11_INSUFFICIENT_ALLOWANCE','R12_STEP_UP_REQUIRED'];
export function orderedRules(rules: Iterable<RuleId>): RuleId[] { const set = new Set(rules); return EVALUATION_ORDER.filter(rule => set.has(rule)); }
