import { createElement } from 'react';
import type { BudgetSnapshot, CartProposal, CartVerdict, MandatePolicy, Operation, Refund, Reservation } from '../shared/types.ts';
import type { DiffRow } from '../domain/policy/diff.ts';

import { CATEGORY_IDS, RULE_IDS } from '../shared/types.ts';
export type ReserveRefusal = Readonly<{ verdict: CartVerdict; budget: BudgetSnapshot }>;
export class ApiError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  readonly refusal: ReserveRefusal | undefined;
  readonly code: string | undefined;
  constructor(message: string, status = 0, uncertain = false, refusal?: ReserveRefusal, code?: string) {
    super(message); this.status = status; this.uncertain = uncertain; this.refusal = refusal; this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function short(value: unknown, max = 128): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function minor(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return minor(value) && value >= min && value <= max; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function hashValue(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function resource(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value); }
function date(value: unknown): value is string { return short(value, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function strings(value: unknown, count: number, length: number): value is string[] { return Array.isArray(value) && value.length <= count && value.every(x => short(x, length)); }
function knownRule(value: string): boolean { return RULE_IDS.some(rule => rule === value); }
function member(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value); }
function rules(value: unknown): boolean { return strings(value, 16, 64) && value.every(knownRule); }
function categories(value: unknown): boolean { return strings(value, 10, 128) && value.every(x => member(x, CATEGORY_IDS)); }
function sameData(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameData(value, b[index]));
  if (isRecord(a) && isRecord(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]));
  return a === b;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
// These guards check bounded wire structure/relationships, never policy eligibility or money arithmetic.
export function isPolicy(value: unknown): value is MandatePolicy {
  if (!isRecord(value)) return false;
  const period = value['period'], compiler = value['compiledBy'];
  return exact(value, ['policyVersion','ownerId','mandateId','version','status','currency','period','allowanceMinor','perOrderMaxMinor','perLineMaxMinor','stepUpThresholdMinor','allowedCategories','deniedCategories','deniedSkus','maxQuantityPerLine','maxLinesPerCart','expiresAt','refundRestoration','merchantId','sourceText','compiledBy','signedAt','contentHash'])
    && value['policyVersion'] === 1 && short(value['ownerId']) && resource(value['mandateId']) && integer(value['version'], 1)
    && member(value['status'], ['DRAFT','ACTIVE','REVOKED','EXPIRED','SUPERSEDED']) && value['currency'] === 'USD'
    && isRecord(period) && exact(period, ['kind','timezone','weekStartsOn']) && period['kind'] === 'weekly' && period['timezone'] === 'Asia/Singapore' && period['weekStartsOn'] === 1
    && ['allowanceMinor','perOrderMaxMinor','perLineMaxMinor','stepUpThresholdMinor'].every(key => integer(value[key], 1, 50000))
    && categories(value['allowedCategories']) && (value['allowedCategories'] as string[]).length >= 1 && categories(value['deniedCategories']) && strings(value['deniedSkus'], 30, 128)
    && integer(value['maxQuantityPerLine'], 1, 20) && integer(value['maxLinesPerCart'], 1, 10)
    && date(value['expiresAt']) && member(value['refundRestoration'], ['never_restore','restore_on_completed_refund']) && resource(value['merchantId'])
    && text(value['sourceText'], 2000) && isRecord(compiler)
    && (compiler['mode'] === 'manual' ? exact(compiler, ['mode']) : exact(compiler, ['mode','model','promptVersion']) && member(compiler['mode'], ['fixture','local','hosted']) && short(compiler['model']) && short(compiler['promptVersion']))
    && (value['status'] === 'DRAFT' ? value['signedAt'] === null && value['contentHash'] === null : date(value['signedAt']) && hashValue(value['contentHash']));
}
export function isProposal(value: unknown): value is CartProposal {
  if (!isRecord(value)) return false;
  const source = value['source'];
  return exact(value, ['proposalId','mandateId','lines','source']) && short(value['proposalId']) && resource(value['mandateId'])
    && Array.isArray(value['lines']) && value['lines'].length <= 100 && value['lines'].every(line => isRecord(line) && exact(line, ['sku','qty']) && short(line['sku']) && finite(line['qty']))
    && isRecord(source) && (source['kind'] === 'owner' ? exact(source, ['kind']) : exact(source, ['kind','mode','model']) && source['kind'] === 'agent' && member(source['mode'], ['fixture','local','hosted']) && short(source['model']));
}
export function isVerdict(value: unknown): value is CartVerdict {
  if (!isRecord(value) || !exact(value, ['proposalId','policyVersion','policyHash','ok','stepUpRequired','lines','ruleIds','itemTotalMinor','shippingMinor','orderTotalMinor'])) return false;
  return short(value['proposalId']) && minor(value['policyVersion']) && Number(value['policyVersion']) >= 1
    && typeof value['policyHash'] === 'string' && /^[a-f0-9]{64}$/.test(value['policyHash'])
    && typeof value['ok'] === 'boolean' && typeof value['stepUpRequired'] === 'boolean'
    && strings(value['ruleIds'], 16, 64) && value['ruleIds'].every(knownRule) && value['ok'] === (value['ruleIds'].length === 0)
    && (!value['ruleIds'].includes('R12_STEP_UP_REQUIRED') || value['stepUpRequired'] === true)
    && (value['itemTotalMinor'] === null || minor(value['itemTotalMinor'])) && minor(value['shippingMinor'])
    && (value['orderTotalMinor'] === null || minor(value['orderTotalMinor']))
    && Array.isArray(value['lines']) && value['lines'].length <= 100 && value['lines'].every(line => isRecord(line)
      && exact(line, ['sku','qty','ok','categoryId','lineTotalMinor','ruleIds','satisfiedClauses']) && short(line['sku']) && typeof line['qty'] === 'number' && Number.isFinite(line['qty']) && typeof line['ok'] === 'boolean'
      && (line['categoryId'] === null || CATEGORY_IDS.some(category => category === line['categoryId'])) && (line['lineTotalMinor'] === null || minor(line['lineTotalMinor']))
      && strings(line['ruleIds'], 16, 64) && line['ruleIds'].every(knownRule) && line['ok'] === (line['ruleIds'].length === 0) && strings(line['satisfiedClauses'], 32, 200));
}
export function isBudget(value: unknown): value is BudgetSnapshot {
  return isRecord(value) && exact(value, ['ownerId','periodKey','allowanceMinor','reservedMinor','capturedMinor','refundedCompletedMinor','restoredMinor','externalRefundedMinor','availableMinor','spendBlocked','spendBlockReasons']) && short(value['ownerId']) && short(value['periodKey']) && typeof value['spendBlocked'] === 'boolean'
    && strings(value['spendBlockReasons'], 100, 160)
    && ['allowanceMinor', 'reservedMinor', 'capturedMinor', 'refundedCompletedMinor', 'restoredMinor', 'externalRefundedMinor', 'availableMinor'].every(field => minor(value[field]));
}

export function linesMatch(proposal: CartProposal, verdict: CartVerdict): boolean {
  return proposal.proposalId === verdict.proposalId && proposal.lines.length === verdict.lines.length
    && proposal.lines.every((line, index) => line.sku === verdict.lines[index]!.sku && line.qty === verdict.lines[index]!.qty);
}
const reservationStates = ['HELD','CREATING','CREATE_UNKNOWN','ORDER_CREATED','APPROVED','CAPTURING','CAPTURE_PROVIDER_PENDING','CAPTURE_UNKNOWN','CAPTURED','RELEASED'];
const anomalies = ['CAPTURE_OVER_HOLD','CAPTURE_AFTER_RELEASE','CURRENCY_MISMATCH','UNKNOWN_CAPTURE_ID','PROVIDER_REVERSAL','UNMATCHED_PROVIDER_REFUND','REFUND_TERMINAL_CONTRADICTION','ORDER_FOR_UNKNOWN_RESERVATION','AMOUNT_CONTRADICTION','AMOUNT_OUT_OF_RANGE','NEGATIVE_AVAILABLE','REFUND_OVER_CAPTURE','CAPTURE_TERMINAL_CONTRADICTION'];
export function isReservation(value: unknown): value is Reservation {
  return isRecord(value) && resource(value['id']) && short(value['ownerId']) && resource(value['mandateId']) && integer(value['policyVersion'], 1) && hashValue(value['policyHash'])
    && short(value['periodKey']) && member(value['restoration'], ['never_restore','restore_on_completed_refund']) && member(value['state'], reservationStates)
    && ['amount','holdMinor','capturedMinor','externalRefundedMinor','createdAt','updatedAt'].every(key => integer(value[key]))
    && (value['orderId'] === null || resource(value['orderId'])) && strings(value['anomalyReasons'], anomalies.length, 128) && value['anomalyReasons'].every(x => member(x, anomalies))
    && typeof value['releaseOnResolve'] === 'boolean';
}
function isPublicOperation(value: unknown): value is Omit<Operation, 'ownerToken'> {
  return isRecord(value) && resource(value['id']) && resource(value['subjectId']) && resource(value['requestId'])
    && member(value['kind'], ['ORDER_CREATE','ORDER_CAPTURE','REFUND_CREATE']) && member(value['state'], ['READY','SENDING','DONE','FAILED_DEFINITIVE','UNKNOWN','MANUAL'])
    && (value['attempt'] === 0 || value['attempt'] === 1) && text(value['canonicalBody'], 65536) && hashValue(value['bodyHash'])
    && ['createdAt','updatedAt','expiresAt','getAttempts'].every(key => integer(value[key]))
    && ['claimedAt','sendDeadline','horizonUntil','nextGetAt'].every(key => value[key] === null || integer(value[key]));
}
function isRefund(value: unknown): value is Refund {
  return isRecord(value) && resource(value['id']) && resource(value['captureId']) && resource(value['reservationId']) && integer(value['amount'], 1)
    && member(value['state'], ['REQUESTED','SUBMITTING','PROVIDER_PENDING','REFUND_UNKNOWN','COMPLETED','FAILED','CANCELLED'])
    && typeof value['completedApplied'] === 'boolean' && (value['providerRefundId'] === null || resource(value['providerRefundId']))
    && integer(value['createdAt']) && integer(value['updatedAt'])
    && (value['state'] !== 'COMPLETED' || value['completedApplied'] === true && resource(value['providerRefundId']));
}
export function isReservationView(value: unknown, selected: string): boolean {
  if (!isRecord(value) || !isReservation(value['reservation']) || value['reservation'].id !== selected
    || !Array.isArray(value['operations']) || value['operations'].length > 100 || !value['operations'].every(isPublicOperation)
    || !Array.isArray(value['refunds']) || value['refunds'].length > 100 || !value['refunds'].every(isRefund)
    || !(value['approveUrl'] === null || short(value['approveUrl'], 2048))) return false;
  const refunds = value['refunds'];
  return refunds.every(refund => refund.reservationId === selected) && value['operations'].every(op => op.kind === 'REFUND_CREATE' ? refunds.some(refund => refund.id === op.subjectId) : op.subjectId === selected);
}
export function reserveRefusal(path: string, status: number, value: Record<string, unknown>, body: unknown): ReserveRefusal | undefined {
  if (path !== '/api/carts/reserve' || !exact(value, ['mode','fixtureLabel','verdict','budget']) || !isVerdict(value['verdict']) || !isBudget(value['budget']) || !isRecord(body) || !isProposal(body['proposal'])) return;
  const verdict = value['verdict'];
  if (verdict.ok || !verdict.ruleIds.length || !linesMatch(body['proposal'], verdict) || verdict.policyHash !== body['expectedPolicyHash']) return;
  const frozenStatus = verdict.ruleIds.length === 1 && verdict.ruleIds[0] === 'R12_STEP_UP_REQUIRED' ? 428 : verdict.ruleIds.includes('R11_INSUFFICIENT_ALLOWANCE') ? 409 : 422;
  if (status !== frozenStatus) return;
  return { verdict, budget: value['budget'] };
}
export function definitivePreEffect(status: number, code: string | undefined): boolean {
  // Deliberately narrow frozen LocalSession/readJson pre-admission codes. No generic
  // 4xx/5xx rule, idempotency-in-progress, timeout, dispatcher or provider whitelist.
  const codes: Record<string, number> = { HOST_FORBIDDEN_403: 403, FETCH_SITE_FORBIDDEN_403: 403, ORIGIN_FORBIDDEN_403: 403,
    ORIGIN_REQUIRED_403: 403, SESSION_EXPIRED_403: 403, SESSION_CLOCK_ROLLBACK_403: 403, CSRF_FORBIDDEN_403: 403,
    JSON_CONTENT_TYPE_REQUIRED_415: 415, JSON_INVALID_400: 400, REQUEST_BODY_CAP_413: 413, HEADERS_CAP_431: 431 };
  return code !== undefined && Object.hasOwn(codes, code) && codes[code] === status;
}


function isDiff(value: unknown, draft: MandatePolicy): boolean {
  const fields = policyFields(draft), names = Object.keys(fields);
  return Array.isArray(value) && value.length === names.length && new Set(value.map(row => isRecord(row) ? row['field'] : null)).size === names.length
    && value.every(row => isRecord(row) && exact(row, ['field','defaultValue','proposedValue','changed']) && typeof row['field'] === 'string' && names.includes(row['field'])
      && typeof row['changed'] === 'boolean' && isPolicy({ ...draft, [row['field']]: row['defaultValue'] })
      && isPolicy({ ...draft, [row['field']]: row['proposedValue'] }) && sameData(row['proposedValue'], fields[row['field']]));
}
export type MutationContext = Readonly<{ policy?: MandatePolicy; reservation?: Reservation }>;
export function mutationResult(path: string, value: Record<string, unknown>, body: unknown, context: MutationContext = {}): boolean {
  if (path === '/api/mandates/compile') return isPolicy(value['draft']) && value['draft'].status === 'DRAFT' && isDiff(value['diff'], value['draft']);
  if (path === '/api/agent/propose') return isProposal(value['proposal']) && isVerdict(value['verdict']) && linesMatch(value['proposal'], value['verdict']);
  if (path === '/api/carts/evaluate') return isRecord(body) && isProposal(body['proposal']) && isVerdict(value['verdict']) && linesMatch(body['proposal'], value['verdict']);
  if (path === '/api/carts/reserve') {
    if (!isRecord(body) || !isProposal(body['proposal']) || !isReservation(value['reservation']) || !isVerdict(value['verdict']) || !isBudget(value['budget'])) return false;
    const r = value['reservation'], verdict = value['verdict'], proposal = body['proposal'];
    return isPolicy(context.policy) && r.ownerId === context.policy.ownerId && r.restoration === context.policy.refundRestoration && r.policyVersion === context.policy.version && r.policyHash === context.policy.contentHash
      && linesMatch(proposal, verdict) && verdict.ok && verdict.ruleIds.length === 0 && verdict.orderTotalMinor !== null
      && r.state === 'HELD' && r.mandateId === proposal.mandateId && r.policyHash === body['expectedPolicyHash'] && r.policyHash === verdict.policyHash
      && r.policyVersion === verdict.policyVersion && r.amount === verdict.orderTotalMinor && r.holdMinor === r.amount && r.capturedMinor === 0
      && r.externalRefundedMinor === 0 && r.orderId === null && r.anomalyReasons.length === 0 && r.releaseOnResolve === false
      && value['budget'].ownerId === r.ownerId && value['budget'].periodKey === r.periodKey;
  }
  let match = /^\/api\/mandates\/([A-Za-z0-9-]{1,128})\/(sign|revoke)$/.exec(path);
  if (match) {
    if (!isPolicy(value['policy']) || value['policy'].mandateId !== match[1] || value['policy'].status !== (match[2] === 'sign' ? 'ACTIVE' : 'REVOKED') || !integer(value['released'])) return false;
    if (match[2] === 'revoke') return isPolicy(context.policy) && context.policy.status === 'ACTIVE'
      && Object.keys(context.policy).filter(key => key !== 'status').every(key => sameData((context.policy as unknown as Record<string, unknown>)[key], (value['policy'] as unknown as Record<string, unknown>)[key]))
      && integer(value['captureClaimedBeforeRevoke']) && integer(value['createClaimedBeforeRevoke']);
    if (!isRecord(body) || !isPolicy(body['draft']) || !isBudget(value['budget']) || value['budget'].ownerId !== value['policy'].ownerId) return false;
    // Signing assigns version/hash/time server-side. All other submitted terms must remain identical.
    const sent = body['draft'], signed = value['policy'];
    return Object.keys(sent).filter(key => !['version','status','signedAt','contentHash'].includes(key)).every(key =>
      sameData((sent as unknown as Record<string, unknown>)[key], (signed as unknown as Record<string, unknown>)[key]));
  }
  match = /^\/api\/reservations\/([A-Za-z0-9-]{1,128})\/(cancel|simulate-approval|checkout|capture)$/.exec(path);
  if (match) {
    if (match[2] === 'cancel') return isReservation(value['reservation']) && value['reservation'].id === match[1]
      && isReservation(context.reservation) && context.reservation.id === match[1]
      && ['ownerId','mandateId','policyVersion','policyHash','periodKey','restoration','amount'].every(key =>
        (context.reservation as unknown as Record<string, unknown>)[key] === (value['reservation'] as unknown as Record<string, unknown>)[key])
      && value['reservation'].state === 'RELEASED' && value['reservation'].holdMinor === 0;
    if (match[2] === 'simulate-approval') return value['reservationId'] === match[1] && value['reconcileRequired'] === true;
    return resource(value['operationId']);
  }
  match = /^\/api\/operations\/([A-Za-z0-9-]{1,128})\/dispatch$/.exec(path);
  if (match) return value['operationId'] === match[1];
  if (/^\/api\/captures\/[A-Za-z0-9-]{1,128}\/refunds$/.test(path)) return resource(value['refundId']) && resource(value['operationId']);
  if (path === '/api/reconcile') return ['checked','changed','anomalies','deferred'].every(field => integer(value[field]));
  return false;
}
export function assertMutationResult(path: string, value: Record<string, unknown>, body: unknown, context: MutationContext = {}): void {
  if (!mutationResult(path, value, body, context)) throw new ApiError('Invalid command evidence. Retain its intent key and inspect outcomes.', 0, true);
}
export function readResult(path: string, value: Record<string, unknown>): boolean {
  if (path === '/api/mandates/current') return isPolicy(value['policy']) && (value['budget'] === null || isBudget(value['budget']) && value['budget'].ownerId === value['policy'].ownerId);
  const match = /^\/api\/reservations\/([A-Za-z0-9-]{1,128})$/.exec(path);
  if (match) return isReservationView(value, match[1]!);
  if (path === '/api/health') return integer(value['now']) && short(value['version']) && hashValue(value['catalogueHash']) && member(value['startupRecovery'], ['running','done','deadline_exceeded']);
  if (path === '/api/catalogue') return Array.isArray(value['items']) && value['items'].length <= 100 && value['items'].every(item =>
    isRecord(item) && short(item['sku']) && short(item['name'], 200) && text(item['description'], 2000) && text(item['imageAlt'], 500) && integer(item['unitPriceMinor'], 1) && item['currency'] === 'USD');
  if (/^\/api\/ledger\?since=\d{1,12}$/.test(path)) return integer(value['nextSince']) && (value['totals'] === null || isBudget(value['totals']))
    && Array.isArray(value['rows']) && value['rows'].length <= 100 && value['rows'].every(row => isRecord(row)
      && integer(row['seq'], 1) && integer(row['at']) && member(row['kind'], ['RESERVE','RELEASE','ORDER','APPROVE','CAPTURE','REFUND_REQ','REFUND_DONE','REFUND_FAIL','RESTORE','REVOKE','SIGN','REJECT','WEBHOOK','RECONCILE','ANOMALY','DISPOSITION'])
      && text(row['note'], 2000) && member(row['source'], ['fixture','sandbox']) && (row['reservationId'] === null || resource(row['reservationId']))
      && ['amountMinor','availableAfter','reservedAfter','capturedAfter','restoredAfter','refundedCompletedAfter'].every(key => minor(row[key]))
      && rules(row['ruleIds']) && isRecord(row['paypal']) && Object.keys(row['paypal']).length <= 6
      && Object.entries(row['paypal']).every(([key, id]) => ['orderId','captureId','refundId','eventId','debugId','requestId'].includes(key) && resource(id)));
  return true;
}

export function responseEvidence(path: string, status: number, parsed: unknown, body: unknown, mutation: boolean, context: MutationContext = {}): Record<string, unknown> {
  if (!isRecord(parsed) || !isRecord(parsed['mode'])) throw new ApiError('Invalid server envelope; inspect the command outcome.', status, mutation);
  const mode = parsed['mode'];
  if (!member(mode['paypal'], ['fixture','sandbox']) || !member(mode['llm'], ['fixture','local']) || mode['vault'] !== 'off' || !short(parsed['fixtureLabel'], 500))
    throw new ApiError('Unexpected server mode', status, mutation);
  if (mode['llm'] === 'local' && (!short(mode['model']) || mode['origin'] !== 'live' || !(mode['digest'] === null || (typeof mode['digest'] === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(mode['digest']))))) throw new ApiError('Invalid local model provenance', status, mutation);
  if (status < 200 || status >= 300) {
    const refusal = reserveRefusal(path, status, parsed, body);
    const code = short(parsed['error'], 160) ? parsed['error'] : undefined;
    const preEffect = definitivePreEffect(status, code) && Object.keys(parsed).every(key => ['mode','fixtureLabel','error'].includes(key));
    throw new ApiError(code ?? (refusal ? 'Reservation refused. Review the current verdict and budget, then deliberately re-evaluate.' : `Request refused (${status})`), status, mutation && !refusal && !preEffect, refusal, code);
  }
  if (mutation) {
    const expectedStatus = /\/(checkout|capture|dispatch|refunds)$/.test(path) ? 202 : 200;
    if (status !== expectedStatus) throw new ApiError('Unexpected command status. Inspect outcomes.', status, true);
    assertMutationResult(path, parsed, body, context);
  } else if (!readResult(path, parsed)) throw new ApiError('Invalid inspection evidence. Read status again.', status);
  return parsed;
}

// Only wrap server-derived review construction; local inputs and unrelated GET errors do not acquire uncertainty.
class ReviewEvidenceError extends Error {}
export function commandEvidence<T>(construct: () => T): T {
  try { return construct(); } catch (error) {
    if (error instanceof ReviewEvidenceError) throw new ApiError('Command review evidence does not match. Inspect outcomes before new commands.', 0, true);
    throw error;
  }
}

// Pure UI policy/review data only. Never import the server hash/schema runtime.
export function policyIdentity(policy: MandatePolicy | null): string {
  return policy ? JSON.stringify([policy.ownerId, policy.mandateId, policy.version, policy.contentHash, policy.status, policy.expiresAt]) : '';
}
export function policyFields(policy: MandatePolicy): Record<string, unknown> {
  const { status: _status, sourceText: _source, compiledBy: _compiler, signedAt: _signed, contentHash: _hash, ...fields } = policy;
  return { ...fields, allowedCategories: [...fields.allowedCategories].sort(), deniedCategories: [...fields.deniedCategories].sort(), deniedSkus: [...fields.deniedSkus].sort() };
}
export function policyComparison(base: Record<string, unknown>, policy: MandatePolicy): readonly DiffRow[] {
  return Object.entries(policyFields(policy)).sort(([a], [b]) => a.localeCompare(b)).map(([field, proposedValue]) => ({
    field, defaultValue: base[field], proposedValue, changed: JSON.stringify(base[field]) !== JSON.stringify(proposedValue),
  }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(item => freeze(item)); Object.freeze(value); }
  return value;
}
export type ReviewedCart = Readonly<{ id: string; proposal: CartProposal; verdict: CartVerdict; policy: MandatePolicy; policyIdentity: string; refused: boolean; refusalBudget: BudgetSnapshot | null }>;
export function reviewedCart(id: string, proposal: CartProposal, verdict: CartVerdict, policy: MandatePolicy, refused = false, refusalBudget: BudgetSnapshot | null = null): ReviewedCart {
  if (!short(id) || !isPolicy(policy) || !isProposal(proposal) || !isVerdict(verdict) || !linesMatch(proposal, verdict)
    || policy.status !== 'ACTIVE' || !policy.contentHash || proposal.mandateId !== policy.mandateId
    || verdict.policyHash !== policy.contentHash || verdict.policyVersion !== policy.version
    || (refused ? !isBudget(refusalBudget) || refusalBudget.ownerId !== policy.ownerId : refusalBudget !== null))
    throw new ReviewEvidenceError('Cart and policy evidence do not match. Evaluate again.');
  // Clone before freezing: later API snapshots cannot mutate reviewed terms.
  return freeze(JSON.parse(JSON.stringify({ id, proposal, verdict, policy, policyIdentity: policyIdentity(policy), refused, refusalBudget })) as ReviewedCart);
}
export function reservable(review: ReviewedCart): boolean {
  return !review.refused && review.verdict.orderTotalMinor !== null
    && (review.verdict.ok || review.verdict.stepUpRequired && review.verdict.ruleIds.length > 0 && review.verdict.ruleIds.every(rule => rule === 'R12_STEP_UP_REQUIRED'));
}
export function displayValue(value: unknown): string {
  if (value === undefined) return 'Unavailable';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'Unavailable';
}



export const paymentLabels = (sandbox: boolean) => ({
  checkout: sandbox ? 'Prepare sandbox checkout' : 'Prepare simulated checkout',
  capture: sandbox ? 'Prepare sandbox capture' : 'Prepare simulated capture',
  refund: sandbox ? 'Prepare sandbox refund intent' : 'Prepare simulated refund intent',
  run: sandbox ? 'Run sandbox operation' : 'Run simulated operation',
  running: sandbox ? 'Running one PayPal sandbox operation' : 'Running one simulated operation',
  recorded: sandbox ? 'Sandbox result recorded' : 'Simulated result recorded',
});

export function OperationAction({ state, sandbox, disabled, onRun }: {
  state: import('../shared/types.ts').Operation['state']; sandbox: boolean; disabled: boolean; onRun: () => void;
}) {
  const labels = paymentLabels(sandbox);
  return state === 'READY'
    ? createElement('button', { disabled, onClick: onRun }, labels.run)
    : createElement('span', { className: 'caption' }, state === 'DONE' ? labels.recorded : 'No replacement POST');
}
