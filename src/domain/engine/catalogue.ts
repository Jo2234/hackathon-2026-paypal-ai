import products from '../../../catalogue/products.json' with { type: 'json' };
import map from '../../../catalogue/category-map.json' with { type: 'json' };
import { CATEGORY_IDS } from '../../shared/types.ts';
import type { CatalogueItem, CategoryMap, EnforcementCatalogue } from '../../shared/types.ts';
import { assertMinor } from '../money.ts';
if (products.length !== 30 || Object.keys(map).length !== 30 || new Set(products.map(item => item.sku)).size !== 30) throw new Error('CATALOGUE_CARDINALITY');
const categories = map as CategoryMap;
for (const item of products) {
  if (!Object.hasOwn(categories, item.sku) || !CATEGORY_IDS.includes(categories[item.sku]!)) throw new Error('CATEGORY_MAP');
  if (item.currency !== 'USD' || assertMinor(item.unitPriceMinor, true) === 0) throw new Error('CATALOGUE_PRICE');
}
export const catalogue: readonly CatalogueItem[] = Object.freeze(products.map(item => Object.freeze({ ...item, currency: 'USD' as const })));
export const categoryMap: CategoryMap = Object.freeze({ ...categories });
export function projectEnforcementCatalogue(items: readonly CatalogueItem[]): EnforcementCatalogue {
  return Object.freeze(Object.fromEntries(items.map(item => [item.sku, Object.freeze({ unitPriceMinor: item.unitPriceMinor, currency: item.currency })])));
}
export const enforcementCatalogue: EnforcementCatalogue = projectEnforcementCatalogue(catalogue);
