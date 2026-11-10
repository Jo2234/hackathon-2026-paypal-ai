import { z } from 'zod';
import { CATEGORY_IDS } from './types.ts';
const id = z.string().min(1).max(128);
const minor = z.number().int().min(1).max(50000);
export const categorySchema = z.enum(CATEGORY_IDS);
export const compilerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual') }).strict(),
  z.object({ mode: z.literal('fixture'), model: id, promptVersion: id }).strict(),
  z.object({ mode: z.literal('local'), model: id, promptVersion: id }).strict(),
  z.object({ mode: z.literal('hosted'), model: id, promptVersion: id }).strict(),
]);
export const policySchema = z.object({
  policyVersion: z.literal(1), ownerId: id, mandateId: id, version: z.number().int().min(1),
  status: z.enum(['DRAFT','ACTIVE','REVOKED','EXPIRED','SUPERSEDED']), currency: z.literal('USD'),
  period: z.object({ kind: z.literal('weekly'), timezone: z.literal('Asia/Singapore'), weekStartsOn: z.literal(1) }).strict(),
  allowanceMinor: minor, perOrderMaxMinor: minor, perLineMaxMinor: minor, stepUpThresholdMinor: minor,
  allowedCategories: z.array(categorySchema).min(1).max(10), deniedCategories: z.array(categorySchema).max(10), deniedSkus: z.array(id).max(30),
  maxQuantityPerLine: z.number().int().min(1).max(20), maxLinesPerCart: z.number().int().min(1).max(10),
  expiresAt: z.iso.datetime(), refundRestoration: z.enum(['restore_on_completed_refund','never_restore']),
  merchantId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), sourceText: z.string().max(2000), compiledBy: compilerSchema,
  signedAt: z.iso.datetime().nullable(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export const proposalSchema = z.object({
  proposalId: id, mandateId: id, lines: z.array(z.object({ sku: id, qty: z.number() }).strict()).max(100),
  source: z.union([z.object({ kind: z.literal('owner') }).strict(), z.object({ kind: z.literal('agent'), mode: z.enum(['fixture','local','hosted']), model: id }).strict()]),
}).strict();
export const ownerReviewSchema = z.object({ confirm: z.literal(true), expectedCurrentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), explicitlyAllowedSensitive: z.array(z.enum(['gift_cards','alcohol'])).max(2) }).strict();
