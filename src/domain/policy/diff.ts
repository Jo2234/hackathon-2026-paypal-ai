import type { MandatePolicy } from '../../shared/types.ts';
import { canonicalJson } from '../../shared/canonical.ts';
import { enforcementFields } from './policy.ts';
export type DiffRow = Readonly<{ field: string; defaultValue: unknown; proposedValue: unknown; changed: boolean }>;
export function reviewDiff(defaults: MandatePolicy, draft: MandatePolicy): readonly DiffRow[] {
  const before = enforcementFields(defaults); const after = enforcementFields(draft);
  return Object.keys(after).sort().map(field => ({ field, defaultValue: before[field], proposedValue: after[field], changed: canonicalJson(before[field]) !== canonicalJson(after[field]) }));
}
