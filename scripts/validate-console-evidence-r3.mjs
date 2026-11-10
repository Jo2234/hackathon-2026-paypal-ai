import assert from 'node:assert/strict';
import {
  ApiError, responseEvidence, commandEvidence, reviewedCart, reservable,
  isPolicy, isProposal, isReservationView, policyFields, policyComparison,
} from '../src/web/review-policy.ts';

// One new direct-Node regression. Runtime graph: this file -> owned pure helper -> shared type/constants.
// No renderer, API import/fetch, external library, server, database or historical test.
let cases = 0, assertions = 0;
function equal(actual, expected) { assertions++; assert.deepEqual(actual, expected); }
function throws(fn, predicate) { assertions++; assert.throws(fn, predicate); }
function test(name, fn) {
  try { fn(); cases++; console.log('ok ' + cases + ' - ' + name); }
  catch (error) { console.log('not ok - ' + name); throw error; } // First red stops, no retries.
}
const clone = value => structuredClone(value);
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
const policy = {
  policyVersion: 1, ownerId: 'owner-1', mandateId: 'mandate-1', version: 2, status: 'ACTIVE', currency: 'USD',
  period: { kind: 'weekly', timezone: 'Asia/Singapore', weekStartsOn: 1 },
  allowanceMinor: 8000, perOrderMaxMinor: 8000, perLineMaxMinor: 3000, stepUpThresholdMinor: 3000,
  allowedCategories: ['coffee_tea', 'printer_supplies'], deniedCategories: ['gift_cards', 'alcohol'], deniedSkus: [],
  maxQuantityPerLine: 5, maxLinesPerCart: 10, expiresAt: '2026-11-30T00:00:00.000Z',
  refundRestoration: 'never_restore', merchantId: 'demo-merchant', sourceText: '',
  compiledBy: { mode: 'manual' }, signedAt: '2026-10-19T00:00:00.000Z', contentHash: hash,
};
const draft = { ...clone(policy), status: 'DRAFT', signedAt: null, contentHash: null };
const proposal = { proposalId: 'proposal-1', mandateId: 'mandate-1', lines: [{ sku: 'COF-001', qty: 1 }], source: { kind: 'owner' } };
const verdict = {
  proposalId: 'proposal-1', policyVersion: 2, policyHash: hash, ok: true, stepUpRequired: false,
  lines: [{ sku: 'COF-001', qty: 1, categoryId: 'coffee_tea', lineTotalMinor: 500, ok: true, ruleIds: [], satisfiedClauses: ['quantity within signed limit'] }],
  ruleIds: [], itemTotalMinor: 500, shippingMinor: 500, orderTotalMinor: 1000,
};
const budget = { ownerId: 'owner-1', periodKey: '2026-10-19', allowanceMinor: 8000, reservedMinor: 1000, capturedMinor: 0,
  refundedCompletedMinor: 0, restoredMinor: 0, externalRefundedMinor: 0, availableMinor: 7000, spendBlocked: false, spendBlockReasons: [] };
const reservation = {
  id: 'reservation-1', ownerId: 'owner-1', mandateId: 'mandate-1', policyVersion: 2, policyHash: hash, periodKey: '2026-10-19',
  restoration: 'never_restore', state: 'HELD', amount: 1000, holdMinor: 1000, capturedMinor: 0, externalRefundedMinor: 0,
  orderId: null, anomalyReasons: [], releaseOnResolve: false, createdAt: 1792368000000, updatedAt: 1792368000000,
};
const operation = {
  id: 'operation-1', kind: 'REFUND_CREATE', subjectId: 'refund-1', requestId: 'request-1', canonicalBody: '{}', bodyHash: hash,
  state: 'DONE', attempt: 1, claimedAt: 1792368000000, sendDeadline: 1792368030000, horizonUntil: 1792454400000,
  nextGetAt: null, getAttempts: 1, expiresAt: 1792369800000, createdAt: 1792368000000, updatedAt: 1792368000000,
};
const refund = {
  id: 'refund-1', captureId: 'capture-1', reservationId: 'reservation-1', amount: 100, state: 'COMPLETED',
  completedApplied: true, providerRefundId: 'provider-refund-1', createdAt: 1792368000000, updatedAt: 1792368000000,
};
const envelope = fields => ({ mode: { paypal: 'fixture', llm: 'fixture', vault: 'off' }, fixtureLabel: 'Synthetic fixture', ...fields });
const reserveBody = { proposal, expectedPolicyHash: hash };
const reserveResult = { reservation, verdict, budget };
const reserveContext = { policy };
const write = (path, fields, body = {}, status = 200, context = {}) => responseEvidence(path, status, envelope(fields), body, true, context);
const reserve = fields => write('/api/carts/reserve', fields, reserveBody, 200, reserveContext);
const uncertain = error => error instanceof ApiError && error.uncertain === true && !error.refusal;
const readError = error => error instanceof ApiError && error.uncertain === false;
const review = (p = proposal, v = verdict, ownerPolicy = policy) => commandEvidence(() => reviewedCart('review-1', p, v, ownerPolicy));
const reservationView = () => ({ reservation: { ...clone(reservation), state: 'CAPTURED', holdMinor: 0, capturedMinor: 1000, orderId: 'order-1' }, operations: [clone(operation)], refunds: [clone(refund)], approveUrl: null });
test('permitted self-reported runtime identity', () => {
  equal(process.version, 'v24.22.0');
  // Portable identity: exact runtime version is pinned; installation path is operator-owned.
  equal(process.release.name, 'node');
  console.log(JSON.stringify({ event: 'identity', pid: process.pid, argv: process.argv, execArgv: process.execArgv, version: process.version, execPath: process.execPath }));
});
test('valid reserve publishes server snapshots unchanged', () => {
  const result = reserve(reserveResult); equal(result.reservation, reservation); equal(result.budget, budget);
});
test('partial reservation R2-01 counterexample is uncertain before publication', () => {
  throws(() => reserve({ ...reserveResult, reservation: { id: reservation.id, ownerId: policy.ownerId, mandateId: policy.mandateId, policyHash: hash, policyVersion: 2, amount: 1000 } }), uncertain);
});
for (const field of Object.keys(reservation)) test('reserve missing consumed reservation field ' + field, () => {
  const next = clone(reserveResult); delete next.reservation[field]; throws(() => reserve(next), uncertain);
});
for (const [field, bad] of [
  ['state', 'MYSTERY'], ['anomalyReasons', ['INVENTED']], ['anomalyReasons', null], ['id', '../r'],
  ['policyVersion', Number.MAX_SAFE_INTEGER + 1], ['policyHash', 'z'.repeat(64)], ['orderId', '../order'],
  ['amount', 1.5], ['holdMinor', -1], ['releaseOnResolve', 0], ['createdAt', Infinity],
  ['ownerId', 'other-owner'], ['restoration', 'restore_on_completed_refund'], ['periodKey', 'other-period'],
]) test('reserve rejects malformed or mismatched ' + field + ':' + String(bad), () => {
  const next = clone(reserveResult); next.reservation[field] = bad; throws(() => reserve(next), uncertain);
});
test('reserve cannot publish a later or cancelled state as new HELD success', () => {
  throws(() => reserve({ ...reserveResult, reservation: { ...reservation, state: 'CAPTURED' } }), uncertain);
});
test('reserve success with failed verdict is uncertain', () => {
  throws(() => reserve({ ...reserveResult, verdict: { ...verdict, ok: false, ruleIds: ['R11_INSUFFICIENT_ALLOWANCE'] } }), uncertain);
});
test('budget identity and safe integer validation precede reserve success', () => {
  throws(() => reserve({ ...reserveResult, budget: { ...budget, ownerId: 'other' } }), uncertain);
  throws(() => reserve({ ...reserveResult, budget: { ...budget, availableMinor: NaN } }), uncertain);
  throws(() => reserve({ ...reserveResult, budget: { ...budget, spendBlockReasons: [null] } }), uncertain);
});
for (const field of Object.keys(policy)) test('policy missing consumed field ' + field, () => {
  const next = clone(policy); delete next[field]; equal(isPolicy(next), false);
});
for (const [field, bad] of [
  ['version', 0], ['version', Number.MAX_SAFE_INTEGER + 1], ['contentHash', 'z'.repeat(64)],
  ['allowedCategories', ['invented']], ['deniedCategories', Array(11).fill('alcohol')],
  ['deniedSkus', ['x'.repeat(129)]], ['period', {}], ['compiledBy', { mode: 'fixture' }],
  ['compiledBy', { mode: 'hosted', model: 'x'.repeat(129), promptVersion: '1' }],
  ['signedAt', null], ['expiresAt', 'tomorrow'], ['sourceText', 'x'.repeat(2001)],
]) test('policy invalid bounded field ' + field + ':' + String(bad), () => {
  const next = clone(policy); next[field] = bad; equal(isPolicy(next), false);
});
test('valid compile uses bounded full DiffRow contract', () => {
  const diff = policyComparison(policyFields(draft), draft);
  equal(write('/api/mandates/compile', { draft, diff }).draft, draft);
  throws(() => write('/api/mandates/compile', { draft: {}, diff: [] }), uncertain);
  throws(() => write('/api/mandates/compile', { draft, diff: diff.slice(1) }), uncertain);
  const broken = clone(diff); broken[0].defaultValue = { nested: { invalid: true } };
  throws(() => write('/api/mandates/compile', { draft, diff: broken }), uncertain);
  const wrong = clone(diff); wrong[0].proposedValue = 'wrong';
  throws(() => write('/api/mandates/compile', { draft, diff: wrong }), uncertain);
});
test('sign accepts server-assigned version and reordered valid object keys', () => {
  const signed = { ...clone(policy), version: 3, period: { weekStartsOn: 1, timezone: 'Asia/Singapore', kind: 'weekly' } };
  equal(write('/api/mandates/mandate-1/sign', { policy: signed, released: 0, budget }, { draft }).policy, signed);
});
for (const change of [{}, { ...policy, status: 'REVOKED' }, { ...policy, ownerId: 'other' }, { ...policy, mandateId: 'other' }, { ...policy, allowanceMinor: 7000 }]) test('sign rejects invalid policy ' + JSON.stringify(change).slice(0, 30), () => {
  throws(() => write('/api/mandates/mandate-1/sign', { policy: change, released: 0, budget }, { draft }), uncertain);
});
test('revoke requires exact prior signed identity and REVOKED state', () => {
  const result = { policy: { ...policy, status: 'REVOKED' }, released: 0, captureClaimedBeforeRevoke: 1, createClaimedBeforeRevoke: 1 };
  equal(write('/api/mandates/mandate-1/revoke', result, {}, 200, { policy }).policy.status, 'REVOKED');
  for (const field of ['ownerId','contentHash','version','status']) {
    const next = clone(result); next.policy[field] = field === 'version' ? 3 : field === 'contentHash' ? otherHash : 'wrong';
    throws(() => write('/api/mandates/mandate-1/revoke', next, {}, 200, { policy }), uncertain);
  }
  throws(() => write('/api/mandates/mandate-1/revoke', { policy: {} }), uncertain);
});
test('cancel binds full released reservation to prior immutable identity', () => {
  const result = { reservation: { ...reservation, state: 'RELEASED', holdMinor: 0, releaseOnResolve: true } };
  equal(write('/api/reservations/reservation-1/cancel', result, {}, 200, { reservation }).reservation.state, 'RELEASED');
  for (const field of ['id','ownerId','policyHash','state']) {
    const next = clone(result); next.reservation[field] = field === 'policyHash' ? otherHash : 'wrong';
    throws(() => write('/api/reservations/reservation-1/cancel', next, {}, 200, { reservation }), uncertain);
  }
  throws(() => write('/api/reservations/reservation-1/cancel', { reservation: {} }, {}, 200, { reservation }), uncertain);
});
test('operation metadata endpoints validate identity and immutable creation status', () => {
  for (const action of ['checkout','capture']) {
    equal(write('/api/reservations/reservation-1/' + action, { operationId: 'operation-1' }, {}, 202).operationId, 'operation-1');
    throws(() => write('/api/reservations/reservation-1/' + action, { operationId: '../bad' }, {}, 202), uncertain);
    throws(() => write('/api/reservations/reservation-1/' + action, { operationId: 'operation-1' }), uncertain);
  }
  equal(write('/api/operations/operation-1/dispatch', { operationId: 'operation-1' }, {}, 202).operationId, 'operation-1');
  throws(() => write('/api/operations/operation-1/dispatch', { operationId: 'other' }, {}, 202), uncertain);
  equal(write('/api/reservations/reservation-1/simulate-approval', { reservationId: 'reservation-1', reconcileRequired: true }).reconcileRequired, true);
  throws(() => write('/api/reservations/reservation-1/simulate-approval', { reservationId: 'other', reconcileRequired: true }), uncertain);
  equal(write('/api/captures/capture-1/refunds', { operationId: 'operation-1', refundId: 'refund-1' }, {}, 202).refundId, 'refund-1');
  throws(() => write('/api/captures/capture-1/refunds', { operationId: 'operation-1' }, {}, 202), uncertain);
});
test('valid cumulative reconcile counters are not confused with per-run scan limits', () => {
  equal(write('/api/reconcile', { checked: 100, changed: 10, anomalies: 120, deferred: 101 }).anomalies, 120);
  throws(() => write('/api/reconcile', { checked: -1, changed: 0, anomalies: 0, deferred: 0 }), uncertain);
});
for (const parsed of [[], null, {}, { mode: null }, envelope({ draft: {} }), envelope({ mode: { paypal: 'sandbox', llm: 'fixture', vault: 'off' } })]) test('invalid outer/nested command evidence cannot escape uncertainty', () => {
  throws(() => responseEvidence('/api/mandates/compile', 200, parsed, {}, true), uncertain);
});
test('only narrow exact pre-effect codes establish definitive refusal', () => {
  throws(() => responseEvidence('/api/carts/reserve', 403, envelope({ error: 'SESSION_EXPIRED_403' }), reserveBody, true), readError);
  for (const [status, fields] of [[503, { error: 'SERVER_STOPPING_503' }], [409, { error: 'idempotency_in_progress' }], [403, { error: 'SESSION_EXPIRED' }], [500, { error: 'SESSION_EXPIRED_403' }], [403, { error: 'SESSION_EXPIRED_403', reservation: {} }]]) {
    throws(() => responseEvidence('/api/carts/reserve', status, envelope(fields), reserveBody, true), uncertain);
  }
});
const refusalRules = [
  { rules: ['R11_INSUFFICIENT_ALLOWANCE'], status: 409, step: false },
  { rules: ['R11_INSUFFICIENT_ALLOWANCE','R12_STEP_UP_REQUIRED'], status: 409, step: true },
  { rules: ['R12_STEP_UP_REQUIRED'], status: 428, step: true },
  { rules: ['R05_CATEGORY_DENIED'], status: 422, step: false },
  { rules: ['R05_CATEGORY_DENIED','R12_STEP_UP_REQUIRED'], status: 422, step: true },
];
for (const row of refusalRules) for (const status of [409,422,428]) test('exact frozen refusal status ' + status + ':' + row.rules.join(','), () => {
  const v = { ...verdict, ok: false, ruleIds: row.rules, stepUpRequired: row.step };
  throws(() => write('/api/carts/reserve', { verdict: v, budget }, reserveBody, status, reserveContext),
    error => error instanceof ApiError && error.uncertain === (status !== row.status) && Boolean(error.refusal) === (status === row.status));
});
// R3-01: a coherent refusal branch is disjoint from possible success/creation evidence.
for (const row of refusalRules) for (const conflict of [{ reservation }, { operationId: 'operation-1' }, { effectId: 'reservation-1' }]) test('conflicting reserve refusal stays uncertain ' + row.status + ':' + Object.keys(conflict)[0] + ':' + row.rules.join(','), () => {
  const v = { ...verdict, ok: false, ruleIds: row.rules, stepUpRequired: row.step };
  throws(() => write('/api/carts/reserve', { verdict: v, budget, ...conflict }, reserveBody, row.status, reserveContext), uncertain);
});
test('refusal mismatched lines/hash and incoherent success stay uncertain', () => {
  const v = { ...clone(verdict), ok: false, ruleIds: ['R11_INSUFFICIENT_ALLOWANCE'] };
  v.lines[0].sku = 'OTHER-001';
  throws(() => write('/api/carts/reserve', { verdict: v, budget }, reserveBody, 409), uncertain);
  throws(() => write('/api/carts/reserve', { verdict: { ...v, policyHash: otherHash }, budget }, reserveBody, 409), uncertain);
  throws(() => write('/api/carts/reserve', { verdict, budget }, reserveBody, 422), uncertain);
});
test('R2-02 equal-total different-SKU counterexample rejected before consent', () => {
  const wrong = clone(verdict); wrong.lines[0].sku = 'OTHER-001';
  throws(() => review(proposal, wrong), uncertain);
  throws(() => write('/api/agent/propose', { proposal, verdict: wrong }), uncertain);
  throws(() => write('/api/carts/evaluate', { verdict: wrong }, { proposal }), uncertain);
  throws(() => reserve({ ...reserveResult, verdict: wrong }), uncertain);
});
for (const [name, change] of [
  ['quantity', v => { v.lines[0].qty = 2; }],
  ['line-count', v => { v.lines.push(clone(v.lines[0])); }],
  ['empty-lines', v => { v.lines = []; }],
  ['proposal-id', v => { v.proposalId = 'other'; }],
  ['policy-version', v => { v.policyVersion = 3; }],
  ['policy-hash', v => { v.policyHash = otherHash; }],
]) test('review rejects exact correspondence/identity mismatch ' + name, () => {
  const v = clone(verdict); change(v); throws(() => review(proposal, v), uncertain);
});
test('line order must match for both separately constructed concurrency snapshots', () => {
  const p = { ...clone(proposal), lines: [{ sku: 'COF-001', qty: 1 }, { sku: 'INK-001', qty: 2 }] };
  const v = { ...clone(verdict), lines: [clone(verdict.lines[0]), { ...clone(verdict.lines[0]), sku: 'INK-001', qty: 2 }] };
  for (const id of ['proposal-A','proposal-B']) {
    const pp = { ...p, proposalId: id }, vv = { ...v, proposalId: id };
    equal(reservable(review(pp, vv)), true);
    throws(() => review(pp, { ...vv, lines: [...vv.lines].reverse() }), uncertain);
  }
});
test('only validated snapshot data is deep cloned/frozen and detached', () => {
  const p = clone(proposal), v = clone(verdict), ownerPolicy = clone(policy);
  const snapshot = review(p, v, ownerPolicy);
  equal(Object.isFrozen(snapshot), true); equal(Object.isFrozen(snapshot.proposal.lines[0]), true);
  equal(Object.isFrozen(snapshot.policy.allowedCategories), true);
  p.lines[0].sku = 'CHANGED'; v.lines[0].qty = 9; ownerPolicy.allowedCategories[0] = 'alcohol';
  equal(snapshot.proposal.lines[0].sku, 'COF-001'); equal(snapshot.verdict.lines[0].qty, 1);
  equal(snapshot.policy.allowedCategories[0], 'coffee_tea');
});
test('normal failed proposals remain displayable without browser business validation', () => {
  const samples = [
    { lines: [], rules: ['R14_CART_SHAPE'], item: 0, total: 500 },
    { lines: [{ sku: 'UNKNOWN-SKU', qty: 1 }], rules: ['R04_UNKNOWN_SKU'] },
    { lines: [{ sku: 'COF-001', qty: 0.5 }], rules: ['R08_QTY'] },
    { lines: [{ sku: 'COF-001', qty: -1 }], rules: ['R08_QTY'] },
    { lines: [{ sku: 'COF-001', qty: 21 }], rules: ['R08_QTY'] },
    { lines: [{ sku: 'COF-001', qty: 1 }, { sku: 'COF-001', qty: 1 }], rules: ['R15_DUPLICATE_SKU'], item: 1000, total: 1500, duplicate: true },
  ];
  for (const sample of samples) {
    const p = { ...clone(proposal), lines: sample.lines };
    const v = { ...clone(verdict), ok: false, ruleIds: sample.rules, itemTotalMinor: sample.item ?? null, orderTotalMinor: sample.total ?? null,
      lines: sample.lines.map(line => ({ ...line, categoryId: line.sku === 'UNKNOWN-SKU' ? null : 'coffee_tea', lineTotalMinor: sample.duplicate ? 500 : null, ok: !!sample.duplicate, ruleIds: sample.duplicate ? [] : sample.rules, satisfiedClauses: [] })) };
    equal(isProposal(p), true); equal(write('/api/agent/propose', { proposal: p, verdict: v }).proposal, p);
    const snapshot = review(p, v); equal(snapshot.verdict.ruleIds, sample.rules); equal(reservable(snapshot), false);
  }
});
test('normal step-up review remains reservable but ordinary failures do not', () => {
  const step = { ...verdict, ok: false, stepUpRequired: true, ruleIds: ['R12_STEP_UP_REQUIRED'] };
  equal(reservable(review(proposal, step)), true);
  equal(reservable(review(proposal, { ...step, ruleIds: ['R05_CATEGORY_DENIED','R12_STEP_UP_REQUIRED'] })), false);
});
test('malformed proposals are rejected structurally rather than frozen', () => {
  for (const p of [{}, { ...proposal, lines: [{ sku: 'COF-001', qty: null }] }, { ...proposal, lines: Array(101).fill(proposal.lines[0]) }, { ...proposal, source: { kind: 'agent' } }]) {
    equal(isProposal(p), false); throws(() => review(p), uncertain);
  }
});
test('review-construction conversion is narrow; local and inspection errors remain themselves', () => {
  const local = new ApiError('Local input invalid');
  throws(() => commandEvidence(() => { throw local; }), error => error === local && !error.uncertain);
  const unrelated = new TypeError('Unrelated local error');
  throws(() => commandEvidence(() => { throw unrelated; }), error => error === unrelated);
  throws(() => responseEvidence('/api/reservations/reservation-1', 200, envelope({ reservation: {} }), {}, false), readError);
});
test('valid terminal GET inspection remains usable, including after malformed write evidence', () => {
  throws(() => reserve({ ...reserveResult, reservation: {} }), uncertain);
  const value = reservationView();
  equal(isReservationView(value, reservation.id), true);
  equal(responseEvidence('/api/reservations/reservation-1', 200, envelope(value), {}, false).refunds[0].state, 'COMPLETED');
});
for (const [name, change] of [
  ['reservation-state', v => { delete v.reservation.state; }],
  ['operation-state', v => { v.operations[0].state = 'INVENTED'; }],
  ['operation-identity', v => { v.operations[0].subjectId = 'other-refund'; }],
  ['operation-attempt', v => { v.operations[0].attempt = 2; }],
  ['operation-array', v => { v.operations = Array(101).fill(operation); }],
  ['refund-state', v => { v.refunds[0].state = 'INVENTED'; }],
  ['refund-reservation', v => { v.refunds[0].reservationId = 'other-reservation'; }],
  ['refund-provider-id', v => { v.refunds[0].providerRefundId = '../refund'; }],
  ['refund-completion-evidence', v => { v.refunds[0].completedApplied = false; }],
  ['order-provider-id', v => { v.reservation.orderId = '../order'; }],
  ['approval-url-bound', v => { v.approveUrl = 'x'.repeat(2049); }],
]) test('GET rejects malformed consumed inspection field ' + name, () => {
  const v = reservationView(); change(v);
  equal(isReservationView(v, reservation.id), false);
  throws(() => responseEvidence('/api/reservations/reservation-1', 200, envelope(v), {}, false), readError);
});
test('current policy, catalogue and ledger consumed fields stay bounded on inspection', () => {
  equal(responseEvidence('/api/mandates/current', 200, envelope({ policy, budget }), {}, false).policy, policy);
  throws(() => responseEvidence('/api/mandates/current', 200, envelope({ policy: {}, budget }), {}, false), readError);
  equal(responseEvidence('/api/catalogue', 200, envelope({ items: [{ sku: 'COF-001', name: 'Coffee', description: '', imageAlt: 'Coffee', unitPriceMinor: 500, currency: 'USD' }] }), {}, false).items.length, 1);
  throws(() => responseEvidence('/api/catalogue', 200, envelope({ items: [{}] }), {}, false), readError);
  equal(responseEvidence('/api/ledger?since=0', 200, envelope({ rows: [], totals: budget, nextSince: 0 }), {}, false).rows, []);
});
console.log(JSON.stringify({ event: 'PASS', cases, assertions, target: 'owned production pure response/review guards only' }));
