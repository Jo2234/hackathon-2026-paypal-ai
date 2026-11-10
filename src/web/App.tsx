import { OperationAction, paymentLabels } from './review-policy.ts';
import { sandboxApprovalUrl } from '../shared/io-contracts.ts';
import { useEffect, useRef, useState } from 'react';
import type { BudgetSnapshot, CartProposal, CartVerdict, CatalogueItem, MandatePolicy, Operation, Refund, Reservation } from '../shared/types.ts';
import { CATEGORY_IDS } from '../shared/types.ts';
import type { DiffRow } from '../domain/policy/diff.ts';
import { ApiError, ConsoleApi, isBudget, isVerdict, minorInput, money } from './api.ts';
import type { Envelope } from './api.ts';
import { commandEvidence, isReservationView, displayValue, policyComparison, policyFields, policyIdentity, reservable, reviewedCart } from './review-policy.ts';
import type { ReviewedCart } from './review-policy.ts';
import { LedgerGrid } from './components/LedgerGrid.tsx';
import type { LedgerRow } from './components/LedgerGrid.tsx';

type Page = 'mandate' | 'cart' | 'ledger' | 'reconcile';
type CartView = { reservation: Reservation; operations: Operation[]; refunds: Refund[]; approveUrl: string | null; reconciliationError:string|null };
type RefundDraft = Readonly<{ intentId: string; reservationId: string; captureId: string; amountText: string;
  sent: boolean; refundId: string | null; operationId: string | null; inspected: string | null }>;
const titles: Record<Page, [string, string]> = { mandate: ['Your rules. Before every payment.', 'Create a mandate'], cart: ['A proposal is never permission.', 'Review a cart'], ledger: ['Every movement has a record.', 'Follow the money'], reconcile: ['Unknown stays unknown until there is evidence.', 'Resolve outcomes'] };
function initialPage(): Page { const path = location.pathname.split('/')[1]; return path === 'cart' || path === 'ledger' || path === 'reconcile' ? path : 'mandate'; }
function defaults(now: number, merchantId='demo-merchant'): MandatePolicy {
  return { policyVersion: 1, ownerId: 'demo-owner', mandateId: crypto.randomUUID(), version: 1, status: 'DRAFT', currency: 'USD', period: { kind: 'weekly', timezone: 'Asia/Singapore', weekStartsOn: 1 }, allowanceMinor: 8000, perOrderMaxMinor: 8000, perLineMaxMinor: 3000, stepUpThresholdMinor: 3000, allowedCategories: ['coffee_tea', 'printer_supplies'], deniedCategories: ['gift_cards', 'alcohol'], deniedSkus: [], maxQuantityPerLine: 5, maxLinesPerCart: 10, expiresAt: new Date(now + 30 * 86400000).toISOString(), refundRestoration: 'never_restore', merchantId, sourceText: '', compiledBy: { mode: 'manual' }, signedAt: null, contentHash: null };
}
function ruleName(value: string): string { return `${value}: ${value.replace(/^R\d+_/, '').toLowerCase().replaceAll('_', ' ')}`; }
function terminalRefund(value: Refund | undefined): value is Refund { return !!value && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(value.state); }
function refundEvidenceIdentity(value: Refund): string { return JSON.stringify([value.id, value.captureId, value.reservationId, value.amount, value.state, value.providerRefundId, value.updatedAt]); }
function Card({ label, value, note, danger = false }: { label: string; value: string; note: string; danger?: boolean }) { return <article className={`balance-card ${danger ? 'danger' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }

export function App() {
  const [api] = useState(() => new ConsoleApi()); const busyRef = useRef(false); const uncertaintyRef = useRef(false);
  const [page, setPage] = useState<Page>(initialPage); const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [uncertain, setUncertain] = useState(false);
  const [health, setHealth] = useState<Envelope | null>(null); const [policy, setPolicy] = useState<MandatePolicy | null>(null);
  const policyRef = useRef<MandatePolicy | null>(null);
  const [budget, setBudget] = useState<BudgetSnapshot | null>(null); const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [draft, setDraft] = useState<MandatePolicy | null>(null); const [comparisonBase, setComparisonBase] = useState<Record<string, unknown>>({});
  const [limits, setLimits] = useState({ allowanceMinor: '80.00', perOrderMaxMinor: '80.00', perLineMaxMinor: '30.00', stepUpThresholdMinor: '30.00' });
  const [signConsent, setSignConsent] = useState('');
  const [compileText, setCompileText] = useState('Allow $80 weekly; max $40 per order, $20 per line; ask above $30. Allow coffee_tea and printer_supplies; deny gift_cards and alcohol.');
  const [requestText, setRequestText] = useState('Restock coffee and printer cleaning supplies'); const [sku, setSku] = useState('COF-001'); const [qty, setQty] = useState(1);
  const [reviews, setReviews] = useState<readonly ReviewedCart[]>([]); const reviewsRef = useRef<readonly ReviewedCart[]>([]); const evaluationEpoch = useRef(0);
  const [consents, setConsents] = useState<readonly string[]>([]); const consentRef = useRef<readonly string[]>([]);
  const [submittedProposals, setSubmittedProposals] = useState<readonly string[]>([]); const submittedRef = useRef(new Set<string>());
  const [modalReview, setModalReview] = useState<ReviewedCart | null>(null); const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null); const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [view, setView] = useState<CartView | null>(null);
  const [reservationId, setReservationId] = useState(new URLSearchParams(location.search).get('r') ?? '');
  const [reservationInput, setReservationInput] = useState(reservationId); const selectedRef = useRef(reservationId);
  const [refundDraft, setRefundDraft] = useState<RefundDraft | null>(null); const sentRefunds = useRef(new Map<string, RefundDraft>());
  const [rows, setRows] = useState<LedgerRow[]>([]); const [nextSince, setNextSince] = useState(0); const [hasMore, setHasMore] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<Envelope | null>(null); const [lastReconcile, setLastReconcile] = useState(''); const [concurrencyResults, setConcurrencyResults] = useState<string[]>([]);
  const sandbox=health?.mode.paypal==='sandbox';
  const nativeLocal=health?.mode.llm==='local';
  const hosted=health?.mode.llm==='hosted';
  const merchantId=String(health?.['merchantId']??'demo-merchant');
  const disabled = !connected || !!busy || uncertain;
  function lockUnknown() { uncertaintyRef.current = true; setUncertain(true); }
  function navigate(next: Page) { history.pushState(null, '', `/${next}${next === 'cart' && reservationId ? `?r=${encodeURIComponent(reservationId)}` : ''}`); setPage(next); }
  function clearReviews() {
    evaluationEpoch.current++; reviewsRef.current = []; setReviews([]); consentRef.current = []; setConsents([]); setModalReview(null); setConcurrencyResults([]);
  }
  function installPolicy(value: MandatePolicy | null) {
    if (policyIdentity(value) !== policyIdentity(policyRef.current)) { clearReviews(); setSignConsent(''); }
    policyRef.current = value; setPolicy(value);
  }
  function edit(value: MandatePolicy, diff?: readonly DiffRow[]) {
    const next = { ...value, merchantId, status: 'DRAFT' as const, signedAt: null, contentHash: null,
      allowedCategories: value.allowedCategories.filter(x => x !== 'gift_cards' && x !== 'alcohol'),
      deniedCategories: [...new Set([...value.deniedCategories, 'gift_cards' as const, 'alcohol' as const])] };
    setDraft(next); setSignConsent('');
    setComparisonBase(diff ? Object.fromEntries(diff.map(row => [row.field, row.defaultValue])) : policyFields(value));
    setLimits({ allowanceMinor: (value.allowanceMinor / 100).toFixed(2), perOrderMaxMinor: (value.perOrderMaxMinor / 100).toFixed(2), perLineMaxMinor: (value.perLineMaxMinor / 100).toFixed(2), stepUpThresholdMinor: (value.stepUpThresholdMinor / 100).toFixed(2) });
  }
  function changeDraft(value: MandatePolicy) { setSignConsent(''); setDraft(value); }
  let preparedDraft: MandatePolicy | null = null;
  try { if (draft) preparedDraft = { ...draft, ...Object.fromEntries(Object.entries(limits).map(([field, value]) => [field, minorInput(value)])) }; } catch { /* Invalid input cannot acquire signing consent. */ }
  const signIdentity = preparedDraft ? JSON.stringify({ draft: preparedDraft, expectedCurrentHash: policy?.contentHash ?? null, policyIdentity: policyIdentity(policy) }) : '';
  const comparisons = preparedDraft ? policyComparison(comparisonBase, preparedDraft) : [];
  function putRefundDraft(value: RefundDraft | null) {
    setRefundDraft(value); if (value?.sent) sentRefunds.current.set(value.reservationId, value);
  }
  function installView(current: Envelope, selected: string) {
    const next = current['reservation'] as Reservation;
    if (!isReservationView(current, selected)) throw new ApiError('Reservation evidence is invalid.');
    if (selectedRef.current !== selected) return;
    if (next.state.includes('UNKNOWN') || (current['operations'] as Operation[]).some(op => op.state === 'UNKNOWN' || op.state === 'MANUAL')) lockUnknown();
    setView({ reservation: next, operations: current['operations'] as Operation[], refunds: current['refunds'] as Refund[], approveUrl: current['approveUrl'] as string | null, reconciliationError:typeof current['reconciliationError']==='string'?current['reconciliationError']:null });
  }
  async function refresh(selected = selectedRef.current) {
    setHealth(await api.get('/api/health'));
    try {
      const value = await api.get('/api/mandates/current'); installPolicy(value['policy'] as MandatePolicy);
      if (isBudget(value['budget'])) setBudget(value['budget']);
    } catch (e) { if (e instanceof ApiError && e.status === 404) { installPolicy(null); setBudget(null); } else throw e; }
    const ledger = await api.get('/api/ledger?since=0'); const values = ledger['rows'] as LedgerRow[];
    setRows(values); setNextSince(Number(ledger['nextSince'])); setHasMore(values.length === 100);
    setBudget(isBudget(ledger['totals']) ? ledger['totals'] : null);
    if (selected) installView(await api.get(`/api/reservations/${encodeURIComponent(selected)}`), selected);
  }
  async function run(label: string, action: () => Promise<void>, mutation = true) {
    if (busyRef.current || mutation && uncertaintyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 320) : 'Request failed');
      if (e instanceof ApiError && e.uncertain) lockUnknown();
      if (e instanceof ApiError && e.status === 403) setConnected(false);
    } finally { busyRef.current = false; setBusy(''); }
  }
  useEffect(() => {
    void run('Connecting to the local service', async () => { await api.bootstrap(); const value = await api.get('/api/catalogue'); setCatalogue(value['items'] as CatalogueItem[]); setConnected(true); await refresh(); }, false);
    const pop = () => { setPage(initialPage()); clearReviews(); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
    // The same ConsoleApi retains keys and the uncertainty lock across renewal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!modalReview) return;
    const dialog = dialogRef.current, target = returnFocusRef.current;
    if (dialog && !dialog.open) dialog.showModal(); cancelRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); if (target?.isConnected) target.focus(); };
  }, [modalReview]);
  function consent(review: ReviewedCart, checked: boolean) {
    const next = checked ? [...new Set([...consentRef.current, review.id])] : consentRef.current.filter(id => id !== review.id);
    consentRef.current = next; setConsents(next);
  }
  function reviewCurrent(review: ReviewedCart): boolean {
    return reviewsRef.current.some(item => item === review) && review.policyIdentity === policyIdentity(policyRef.current);
  }
  function eligible(review: ReviewedCart): boolean {
    return reviewCurrent(review) && reservable(review) && consentRef.current.includes(review.id) && !submittedRef.current.has(review.proposal.proposalId);
  }
  async function evaluate(kind: 'manual' | 'fixture' | 'pair' | 'copy', basis?: ReviewedCart) {
    const previous = basis ?? reviewsRef.current[0]; const snapshot = policyRef.current;
    clearReviews(); const epoch = evaluationEpoch.current;
    if (!snapshot || snapshot.status !== 'ACTIVE' || !snapshot.contentHash) throw new ApiError('Sign an active mandate first.');
    try {
      let next: ReviewedCart[];
      if (kind === 'fixture') {
        const value = await api.post('/api/agent/propose', { request: requestText }, `propose:${snapshot.contentHash}:${requestText}`);
        if (!isVerdict(value['verdict'])) throw new ApiError('Invalid proposal verdict.', 0, true);
        setNotice(`Returned model: ${JSON.stringify(value['modelProvenance']??value['mode'])}; owner review required.`);
        next = [commandEvidence(() => reviewedCart(crypto.randomUUID(), value['proposal'] as CartProposal, value['verdict'] as CartVerdict, snapshot))];
      } else {
        const proposals: CartProposal[] = Array.from({ length: kind === 'pair' ? 2 : 1 }, () => ({
          proposalId: crypto.randomUUID(), mandateId: snapshot.mandateId,
          lines: (kind === 'pair' || kind === 'copy') && previous ? previous.proposal.lines.map(line => ({ ...line })) : [{ sku, qty }], source: { kind: 'owner' },
        }));
        next = [];
        for (const proposal of proposals) {
          const result = await api.post('/api/carts/evaluate', { proposal }, `evaluate:${proposal.proposalId}`);
          if (!isVerdict(result['verdict'])) throw new ApiError('Invalid evaluation verdict.', 0, true);
          next.push(commandEvidence(() => reviewedCart(crypto.randomUUID(), proposal, result['verdict'] as CartVerdict, snapshot)));
        }
      }
      if (epoch !== evaluationEpoch.current || policyIdentity(snapshot) !== policyIdentity(policyRef.current)) throw new ApiError('Inputs or policy changed during evaluation. Evaluate again.');
      reviewsRef.current = next; setReviews(next);
    } catch (e) { clearReviews(); throw e; }
  }
  async function reserve(review: ReviewedCart): Promise<Reservation> {
    if (!eligible(review) || uncertaintyRef.current) throw new ApiError('Review and confirm this exact cart again before reserving.');
    submittedRef.current.add(review.proposal.proposalId); setSubmittedProposals([...submittedRef.current]);
    try {
      const result = await api.post('/api/carts/reserve', { proposal: review.proposal, expectedPolicyHash: review.verdict.policyHash,
        ...(review.verdict.stepUpRequired ? { stepUpConfirmed: true } : {}) }, `reserve:${review.proposal.proposalId}`, { policy: review.policy });
      const next = result['reservation'] as Reservation;
      const resultVerdict = result['verdict'];
      if (!isVerdict(resultVerdict) || resultVerdict.proposalId !== review.proposal.proposalId || resultVerdict.policyHash !== review.verdict.policyHash || resultVerdict.policyVersion !== review.verdict.policyVersion
        || !next || !next.id || next.ownerId !== review.policy.ownerId || next.policyHash !== review.verdict.policyHash || next.mandateId !== review.proposal.mandateId || next.policyVersion !== review.verdict.policyVersion || next.amount !== review.verdict.orderTotalMinor) throw new ApiError('Reservation response is not bound to the reviewed cart. Inspect outcomes.', 0, true);
      if (isBudget(result['budget'])) setBudget(result['budget']);
      return next;
    } catch (e) {
      consent(review, false);
      if (e instanceof ApiError && e.uncertain) lockUnknown();
      if (e instanceof ApiError && e.refusal) {
        const { verdict, budget: authoritative } = e.refusal;
        if (verdict.proposalId !== review.proposal.proposalId || verdict.policyHash !== review.verdict.policyHash || verdict.policyVersion !== review.verdict.policyVersion || authoritative.ownerId !== review.policy.ownerId) {
          lockUnknown(); throw new ApiError('Refusal evidence does not match this cart. Inspect outcomes.', e.status, true);
        }
        if (reviewCurrent(review)) {
          const refused = commandEvidence(() => reviewedCart(review.id, review.proposal, verdict, review.policy, true, authoritative));
          const next = reviewsRef.current.map(item => item === review ? refused : item); reviewsRef.current = next; setReviews(next); setBudget(authoritative);
        }
      }
      throw e;
    }
  }
  async function chooseReservation(id: string) {
    if (id !== selectedRef.current) { setView(null); setRefundDraft(null); }
    selectedRef.current = id; setReservationId(id); setReservationInput(id);
    // Unsent input is cleared; an already sent intent is retained by reservation,
    // including its key/unknown state. It cannot become a fresh refund on return.
    setRefundDraft(sentRefunds.current.get(id) ?? null);
    installView(await api.get(`/api/reservations/${encodeURIComponent(id)}`), id);
    history.replaceState(null, '', `/cart?r=${encodeURIComponent(id)}`); await refresh(id);
  }
  async function reconcile(id?: string) {
    const result = await api.post('/api/reconcile', { scope: id ? { reservationId: id } : 'all' }, `reconcile:${crypto.randomUUID()}`);
    setReconcileResult(result); setLastReconcile(new Date().toLocaleTimeString('en-SG')); await refresh(id ?? selectedRef.current);
  }
  function approvalLink(value: string | null): string | null {
    if (!value) return null;
    try { if(sandbox)return view?.reservation.orderId?sandboxApprovalUrl(value,view.reservation.orderId):null;const url=new URL(value,location.origin);return url.origin===location.origin && url.pathname==='/api/fixtures/approval'?url.href:null; } catch {return null;}
  }
  const r = view?.reservation;
  const unknown = r && view && (r.state.includes('UNKNOWN') || view.operations.some(op => op.state === 'UNKNOWN' || op.state === 'MANUAL'));
  const completedRefundMinor = r && view ? view.refunds.filter(refund => refund.reservationId === r.id && refund.state === 'COMPLETED' && refund.completedApplied).reduce((sum, refund) => sum + refund.amount, 0) : 0;
  const outcomeLabel = r?.state === 'CAPTURED' && !unknown && !r.anomalyReasons.length && r.capturedMinor > 0 && completedRefundMinor === r.capturedMinor ? 'REFUNDED' : r?.state.replaceAll('_', ' ');
  const captureEvidence = [...new Map(rows.filter(row => row.reservationId === r?.id && row.kind === 'CAPTURE' && row.paypal?.['captureId']
    && /^[A-Za-z0-9-]{1,128}$/.test(row.paypal['captureId']) && Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0)
    .map(row => [row.paypal!['captureId']!, row] as const)).values()];
  const selectedCapture = captureEvidence.find(row => row.paypal?.['captureId'] === refundDraft?.captureId && row.reservationId === refundDraft?.reservationId);
  const retainedRefund = refundDraft?.sent ? view?.refunds.find(f => f.id === refundDraft.refundId && f.captureId === refundDraft.captureId && f.reservationId === refundDraft.reservationId) : undefined;
  const priorTerminal = terminalRefund(retainedRefund) && !!view?.operations.some(op => op.id === refundDraft?.operationId && op.kind === 'REFUND_CREATE' && op.subjectId === retainedRefund.id && ['DONE', 'FAILED_DEFINITIVE'].includes(op.state)) ? retainedRefund : undefined;
  async function prepareRefund() {
    const intent = refundDraft;
    if (!r || !intent || intent.sent || intent.reservationId !== r.id || selectedRef.current !== r.id || !selectedCapture || r.anomalyReasons.length) throw new ApiError('Select retained capture evidence for this reservation first.');
    const body = { reason: 'requested_by_owner', ...(intent.amountText ? { amountMinor: minorInput(intent.amountText) } : {}) };
    const sent = { ...intent, sent: true }; putRefundDraft(sent);
    const result = await api.post(`/api/captures/${intent.captureId}/refunds`, body, `refund:${intent.intentId}`);
    if (typeof result['refundId'] !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result['refundId']) || typeof result['operationId'] !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result['operationId'])) throw new ApiError('Refund creation identity unavailable. Retain this intent and inspect outcomes.', 0, true);
    // The immutable 202 identifies creation only; GET below establishes outcome.
    putRefundDraft({ ...sent, refundId: result['refundId'], operationId: result['operationId'] }); await refresh(r.id);
  }
  function newRefundIntent() {
    if (!r || uncertaintyRef.current) return;
    const prior = sentRefunds.current.get(r.id);
    if (prior && (!priorTerminal || prior.inspected !== refundEvidenceIdentity(priorTerminal))) return;
    setRefundDraft({ intentId: crypto.randomUUID(), reservationId: r.id, captureId: '', amountText: '', sent: false, refundId: null, operationId: null, inspected: null });
  }
  function renderReview(review: ReviewedCart, index: number) {
    const verdict = review.verdict;
    return <article className="cart-verdict" key={review.id}>
      <p className="eyebrow">REVIEWED CART {index + 1}</p><code className="identity">{review.proposal.proposalId} · policy v{verdict.policyVersion} · {verdict.policyHash}</code>
      <h3>{money(verdict.orderTotalMinor)} <small>including {money(verdict.shippingMinor)} shipping</small></h3>
      {verdict.lines.map((line, i) => <div className="verdict-line" key={`${line.sku}:${i}`}><span>{line.ok ? '✓' : '!'}</span><div><strong>{line.qty} × {catalogue.find(item => item.sku === line.sku)?.name ?? line.sku}</strong><small>{line.ruleIds.length ? line.ruleIds.map(ruleName).join(' · ') : line.satisfiedClauses.join(' · ')}</small></div><b>{money(line.lineTotalMinor)}</b></div>)}
      {!!verdict.ruleIds.length && <p className="rule-errors">{verdict.ruleIds.map(ruleName).join(' · ')}</p>}
      {review.refused && <div className="alert error"><strong>Reservation refused.</strong><span>Needed {money(verdict.orderTotalMinor)}; authoritative available {money(review.refusalBudget?.availableMinor)} in {review.refusalBudget?.periodKey}. Held {money(review.refusalBudget?.reservedMinor)}; gross captured {money(review.refusalBudget?.capturedMinor)}. This intent stays consumed. Review the rules and deliberately evaluate a new cart; no retry or key rotation is automatic.</span></div>}
      {verdict.stepUpRequired ? <button className="secondary" disabled={disabled || !reservable(review) || submittedProposals.includes(review.proposal.proposalId)} onClick={event => { consent(review, false); returnFocusRef.current = event.currentTarget; setModalReview(review); }}>{consents.includes(review.id) ? 'Review step-up consent again' : 'Review step-up confirmation'}</button>
        : <label className="confirm"><input type="checkbox" disabled={disabled || !reservable(review) || submittedProposals.includes(review.proposal.proposalId)} checked={consents.includes(review.id)} onChange={e => consent(review, e.target.checked)} />I reviewed this exact cart, amount and policy identity.</label>}
      {verdict.stepUpRequired && consents.includes(review.id) && <p role="status">Step-up confirmed for this reviewed snapshot.</p>}
      {reviews.length === 1 && <button disabled={disabled || !eligible(review) || !!budget?.spendBlocked} onClick={() => void run('Reserving reviewed funds', async () => { const next = await reserve(review); await chooseReservation(next.id); })}>Reserve {money(verdict.orderTotalMinor)}</button>}
      {submittedProposals.includes(review.proposal.proposalId) && !review.refused && <p className="caption">This reserve intent has been submitted. Inspect its outcome; do not replace an unknown payment.</p>}
      {(review.refused || submittedProposals.includes(review.proposal.proposalId)) && <button className="secondary" disabled={disabled} onClick={() => void run('Evaluating a deliberately new reserve intent', () => evaluate('copy', review))}>Evaluate this as a new reserve intent</button>}
    </article>;
  }

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/mandate" onClick={event => { event.preventDefault(); navigate('mandate'); }}><span className="brand-icon">m<span>·</span></span><span>mandate<br /><b>ledger</b></span></a><p className="nav-label">OWNER WORKSPACE</p><nav>{(['mandate', 'cart', 'ledger', 'reconcile'] as const).map((item, i) => <button key={item} className={page === item ? 'selected' : ''} onClick={() => navigate(item)}><span className="nav-number">0{i + 1}</span>{item[0]!.toUpperCase() + item.slice(1)}<span aria-hidden="true">↗</span></button>)}</nav><div className="sidebar-note"><span className="status-dot" /> LOCAL DEMO ONLY<p>Policy enforced by our service before PayPal calls.</p><small>{sandbox?'No real money. PayPal sandbox calls; synthetic catalogue.':'No PayPal calls in fixture mode.'}</small></div></aside>
    <div className="workspace"><div className="mode-banner" role="status"><strong>{health?(sandbox?'PAYPAL SANDBOX':'FIXTURE'):'CONNECTING'}</strong><span>{sandbox?'PayPal sandbox · synthetic catalogue · GET reconciliation':'PayPal fixture · no PayPal calls'} · Model: {health?.mode.llm!=='fixture'&&health?`live ${health.mode.llm} · ${health.mode.provider??'local'} · configured ${health.mode.model} · digest ${health.mode.digest??'unavailable'}`:'handwritten fixture'} · Vault: off</span><button className="connection text-button" disabled={!!busy} onClick={() => void run('Renewing owner session', async () => { await api.bootstrap(); setConnected(true); await refresh(); }, false)}>{connected ? '● Renew owner session' : '○ Connect owner session'}</button></div>
      <main><header className="page-header"><div><p className="eyebrow">MANDATE LEDGER / {page.toUpperCase()}</p><h1>{titles[page][1]}</h1><p>{titles[page][0]}</p></div><span className="owner-badge">DEMO OWNER <span>↙</span></span></header>
        <section className="balance-strip" aria-label="Server budget counters"><Card label="Available to spend" value={money(budget?.availableMinor)} note={budget?.periodKey ?? 'Sign a mandate to begin'} danger={!!budget && budget.availableMinor < 0} /><Card label="Reserved / held" value={money(budget?.reservedMinor)} note="Unresolved funds stay held" /><Card label="Gross captured" value={money(budget?.capturedMinor)} note="Not reduced by refunds" /><Card label="Completed refunds" value={money(budget?.refundedCompletedMinor)} note={`${money(budget?.restoredMinor)} restored to allowance`} /></section>
        {budget?.spendBlocked && <div className="alert error" role="alert"><strong>New spending is blocked.</strong><span>{budget.spendBlockReasons.join(' · ')}</span><button className="text-button" onClick={() => navigate('reconcile')}>Review outcomes →</button></div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        {uncertain && <div className="alert error" role="alert"><strong>Command response unknown.</strong>New commands are disabled in this page session. Read-only refresh, session renewal and bounded reconciliation retain intent keys and this lock. Do not create a replacement payment.</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}{busy && <div className="working" role="status"><span className="spinner" />{busy}…</div>}
        {page === 'mandate' && <div className="two-column">
          <section className="panel"><p className="eyebrow">01 / DEFINE PERMISSION</p><h2>A mandate the service can check.</h2><p className="subtle">{nativeLocal ? 'Native local AI extracts four USD limits and allowed/denied categories into an unsigned draft. Expiry, quantity/cart limits and refund rules start from server defaults. Full natural-language policy compilation is not supported.' : hosted ? 'Hosted AI uses the full policy tool to propose an unsigned draft. Tool compatibility and semantic quality have not been verified live.' : 'Fixture mode uses handwritten example drafts; it does not call a model.'} Review and edit every field before signing.</p>
            <p className="caption">{nativeLocal ? 'Native local mode excludes catalogue display and merchant text from model input. Owner-goal injection was not measured. Observed hardware: M5 32 GB; model download: 5.23 GB.' : hosted ? 'Hosted mode sends catalogue names, descriptions, image text and supplied merchant text, plus owner instructions and synthetic policy/budget context, to Groq. Merchant text is delimited as untrusted, not excluded. Do not enter confidential or payment data.' : 'Fixture mode makes no model calls. Live model capability and data flow depend on the selected mode.'}</p><label>Your instructions<textarea rows={5} maxLength={2000} value={compileText} onChange={e => setCompileText(e.target.value)} /></label>
            <div className="button-row"><button disabled={disabled} onClick={() => void run('Compiling model candidate', async () => { setSignConsent(''); const value = await api.post('/api/mandates/compile', { text: compileText }, `compile:${compileText}`); edit(value['draft'] as MandatePolicy, value['diff'] as DiffRow[]); setNotice(`Review every rule before signing. Model output cannot sign. Returned model: ${JSON.stringify(value['modelProvenance'])}`); })}>Review AI proposal →</button><button className="secondary" disabled={disabled} onClick={() => edit(defaults(Number(health?.['now'] ?? Date.now()),merchantId))}>Edit manually</button></div>
            <p className="caption">{health?.mode.llm!=='fixture'?'Live model; errors fail closed. Owner review required.':'Only the handwritten example is available. Unmatched input fails closed.'}</p>
            {policy && <div className="policy-card"><span className={`event ${policy.status === 'ACTIVE' ? 'event-sign' : ''}`}>{policy.status}</span><h3>{money(policy.allowanceMinor)} / week</h3><p>{policy.allowedCategories.map(x => x.replaceAll('_', ' ')).join(', ')}</p><small>Version {policy.version} · Asia/Singapore · Monday reset</small><details><summary>Signed policy identity</summary><code>{policy.contentHash}</code></details><div className="button-row"><button className="secondary" disabled={disabled} onClick={() => edit(policy)}>Review a replacement</button><button className="danger-button" disabled={disabled || policy.status !== 'ACTIVE'} onClick={() => { if (confirm('Revoke this mandate? Earlier capture claims may still complete.')) void run('Revoking mandate', async () => { const value = await api.post(`/api/mandates/${policy.mandateId}/revoke`, {}, `revoke:${policy.contentHash}`, { policy }); clearReviews(); setNotice(`Revoked. New capture requests are blocked. ${typeof value['captureClaimedBeforeRevoke'] === 'number' ? value['captureClaimedBeforeRevoke'] : 'An unknown number of'} earlier capture claims may still complete.`); await refresh(); }); }}>Revoke</button></div></div>}
          </section>
          <section className="panel"><p className="eyebrow">02 / OWNER REVIEW</p><h2>Explicit limits. No implied consent.</h2>{draft ? <>
            <div className="form-grid">{(Object.keys(limits) as (keyof typeof limits)[]).map(field => <label key={field}>{({ allowanceMinor: 'Weekly allowance · USD', perOrderMaxMinor: 'Per-order maximum · USD', perLineMaxMinor: 'Per-line maximum · USD', stepUpThresholdMinor: 'Confirm from · USD' })[field]}<input disabled={!!busy} inputMode="decimal" value={limits[field]} onChange={e => { setSignConsent(''); setLimits({ ...limits, [field]: e.target.value }); }} /></label>)}</div>
            <fieldset disabled={!!busy}><legend>Allowed categories</legend><div className="checks">{CATEGORY_IDS.map(category => <label key={category}><input type="checkbox" checked={draft.allowedCategories.includes(category)} onChange={e => changeDraft({ ...draft, allowedCategories: e.target.checked ? [...draft.allowedCategories, category] : draft.allowedCategories.filter(x => x !== category), deniedCategories: e.target.checked ? draft.deniedCategories.filter(x => x !== category) : draft.deniedCategories })} />{category.replaceAll('_', ' ')}</label>)}</div></fieldset>
            <fieldset disabled={!!busy}><legend>Denied categories</legend><div className="checks">{CATEGORY_IDS.map(category => <label key={category}><input type="checkbox" checked={draft.deniedCategories.includes(category)} onChange={e => changeDraft({ ...draft, deniedCategories: e.target.checked ? [...draft.deniedCategories, category] : draft.deniedCategories.filter(x => x !== category), allowedCategories: e.target.checked ? draft.allowedCategories.filter(x => x !== category) : draft.allowedCategories })} />{category.replaceAll('_', ' ')}</label>)}</div></fieldset>
            <fieldset disabled={!!busy}><legend>Denied catalogue SKUs</legend><div className="checks">{catalogue.map(item => <label key={item.sku}><input type="checkbox" checked={draft.deniedSkus.includes(item.sku)} onChange={e => changeDraft({ ...draft, deniedSkus: e.target.checked ? [...draft.deniedSkus, item.sku] : draft.deniedSkus.filter(x => x !== item.sku) })} />{item.name}</label>)}</div></fieldset>
            <div className="form-grid"><label>Maximum quantity per line<input disabled={!!busy} type="number" min={1} max={20} value={draft.maxQuantityPerLine} onChange={e => changeDraft({ ...draft, maxQuantityPerLine: Number(e.target.value) })} /></label><label>Maximum lines per cart<input disabled={!!busy} type="number" min={1} max={10} value={draft.maxLinesPerCart} onChange={e => changeDraft({ ...draft, maxLinesPerCart: Number(e.target.value) })} /></label></div>
            <label>Expiry · ISO date/time with timezone<input disabled={!!busy} value={draft.expiresAt} maxLength={40} onChange={e => changeDraft({ ...draft, expiresAt: e.target.value })} /></label>
            <label>Refund restoration<select disabled={!!busy} value={draft.refundRestoration} onChange={e => changeDraft({ ...draft, refundRestoration: e.target.value as MandatePolicy['refundRestoration'] })}><option value="never_restore">Never restore allowance</option><option value="restore_on_completed_refund">Restore only on completed refunds</option></select></label>
            <p className="caption">Owner, mandate identity, policy version, USD currency, weekly Singapore period and bound merchant are fixed in this form and included below. Server validation remains authoritative. Sensitive categories start unticked on every new review.</p>
            {preparedDraft ? <details open><summary>{comparisons.length} final rule comparisons</summary><div className="comparison-scroll"><table className="comparison"><caption>Current edited draft compared with defaults or the replacement baseline</caption><thead><tr><th scope="col">Field</th><th scope="col">Default / baseline</th><th scope="col">Proposed value</th><th scope="col">Changed</th></tr></thead><tbody>{comparisons.map(row => <tr key={row.field}><th scope="row">{row.field}</th><td><pre>{displayValue(row.defaultValue)}</pre></td><td><pre>{displayValue(row.proposedValue)}</pre></td><td>{row.changed ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div></details> : <p role="alert">Enter valid amounts to review the final comparison.</p>}
            <label className="confirm"><input type="checkbox" disabled={disabled || !signIdentity} checked={!!signIdentity && signConsent === signIdentity} onChange={e => setSignConsent(e.target.checked ? signIdentity : '')} />I reviewed these exact terms and authorize this local policy.</label>
            <button disabled={disabled || !signIdentity || signConsent !== signIdentity} onClick={() => void run('Signing reviewed mandate', async () => {
              if (!preparedDraft || !signIdentity || signConsent !== signIdentity || policyIdentity(policyRef.current) !== policyIdentity(policy)) throw new ApiError('Review the final policy terms again.');
              const signed = preparedDraft; clearReviews(); setSignConsent('');
              const value = await api.post(`/api/mandates/${signed.mandateId}/sign`, { draft: signed, expectedCurrentHash: policy?.contentHash ?? null, confirm: true, explicitlyAllowedSensitive: signed.allowedCategories.filter(x => x === 'gift_cards' || x === 'alcohol') }, `sign:${JSON.stringify(signed)}`);
              installPolicy(value['policy'] as MandatePolicy); setDraft(null); await refresh(); setNotice('Mandate signed. Evaluate carts against the new policy identity.');
            })}>Sign reviewed mandate →</button>
          </> : <div className="empty-state"><span>✧</span><h3>Review starts here.</h3><p>Compile a proposal or open the manual form. Nothing is signed automatically.</p></div>}</section>
        </div>}
        {page === 'cart' && <>
          {new URLSearchParams(location.search).get('checkout') === 'cancelled' && <p role="status">Checkout cancelled. No payment or reservation release is implied. Read approval status before any further action.</p>}
          {new URLSearchParams(location.search).get('checkout') === 'returned' && <p role="status">Checkout return received. Read approval status to reconcile; capture remains a separate explicit action.</p>}
          <div className="two-column"><section className="panel"><p className="eyebrow">PROPOSE / EVALUATE / RESERVE</p><h2>Let the rules decide.</h2>
            <label>Request<input disabled={!!busy} maxLength={500} value={requestText} onChange={e => { clearReviews(); setRequestText(e.target.value); }} /></label>
            <p className="caption">{nativeLocal ? 'Native local AI selects a SKU and quantity from five trusted choices: Ground coffee, Printer cleaning kit, Tea bags, Black ink refill, Synthetic gift voucher.' : hosted ? 'Hosted AI uses the full cart-proposal tool with catalogue and merchant text sent to Groq; it is not limited to the five-choice native recipe. Live hosted quality is unverified.' : 'Fixture mode returns handwritten example cart proposals without model calls.'} The server evaluates against your signed mandate. Selection is not approval.</p><button disabled={disabled || !policy} onClick={() => void run('Requesting agent proposal', () => evaluate('fixture'))}>Propose agent cart →</button>
            <div className="separator"><span>or choose a trusted catalogue item</span></div><div className="form-grid"><div><label htmlFor="catalogue-item">Item</label><select id="catalogue-item" disabled={!!busy} value={sku} onChange={e => { clearReviews(); setSku(e.target.value); }}>{catalogue.map(item => <option value={item.sku} key={item.sku}>{item.name} · {money(item.unitPriceMinor)}</option>)}</select></div><label>Quantity<input disabled={!!busy} type="number" min={1} max={20} value={qty} onChange={e => { clearReviews(); setQty(Number(e.target.value)); }} /></label></div>
            <button className="secondary" disabled={disabled || !policy} onClick={() => void run('Evaluating cart', () => evaluate('manual'))}>Evaluate manual cart</button>
            {reviews.length === 1 && renderReview(reviews[0]!, 0)}
          </section><section className="panel"><p className="eyebrow">RESERVATION / OUTCOME</p><div className="panel-heading"><h2>Follow the evidence.</h2><button className="secondary small" disabled={!connected || !!busy} onClick={() => void run('Refreshing outcome', () => refresh(), false)}>Refresh</button></div>
            <label htmlFor="reservation-id">Reservation ID</label><div className="inline-input"><input id="reservation-id" disabled={!!busy} maxLength={128} value={reservationInput} onChange={e => setReservationInput(e.target.value)} /><button className="secondary" disabled={!connected || !!busy || !/^[A-Za-z0-9-]{1,128}$/.test(reservationInput)} onClick={() => void run('Reading reservation', () => chooseReservation(reservationInput), false)}>Load</button></div>
            {r && view ? <><span className={`event ${unknown ? 'event-anomaly' : ''}`}>{outcomeLabel}</span><h3 className="receipt-amount">{money(r.amount)}</h3><p>Held {money(r.holdMinor)} · gross captured {money(r.capturedMinor)}</p><code className="identity">{r.id}</code>
              {unknown && <div className="alert error">Outcome unknown. Funds remain held where required. Reconciliation reads known provider resources; it never retries a payment.</div>}
              {!!r.anomalyReasons.length && <p className="rule-errors">{r.anomalyReasons.join(' · ')}</p>}
              <div className="button-row">{r.state === 'HELD' && <button disabled={disabled || !!unknown} onClick={() => void run(paymentLabels(sandbox).checkout, async () => { await api.post(`/api/reservations/${r.id}/checkout`, {}, `checkout:${r.id}`); await refresh(r.id); })}>{paymentLabels(sandbox).checkout}</button>}{r.state === 'APPROVED' && <button disabled={disabled || !!unknown} onClick={() => void run(paymentLabels(sandbox).capture, async () => { await api.post(`/api/reservations/${r.id}/capture`, {}, `capture:${r.id}`); await refresh(r.id); })}>{paymentLabels(sandbox).capture}</button>}{['HELD', 'ORDER_CREATED', 'APPROVED'].includes(r.state) && <button className="secondary" disabled={disabled || !!unknown} onClick={() => void run('Requesting local cancellation', async () => { await api.post(`/api/reservations/${r.id}/cancel`, {}, `cancel:${r.id}`, { reservation: r }); await refresh(r.id); })}>Cancel if safe</button>}</div>
              {view.operations.map(op => <div className="operation" key={op.id}><div><strong>{op.kind.replaceAll('_', ' ')}</strong><small>{op.state} · attempt {op.attempt}/1</small><code>{op.id}</code></div><OperationAction state={op.state} sandbox={sandbox} disabled={!!(disabled || unknown)} onRun={() => void run(paymentLabels(sandbox).running, async () => { await api.post(`/api/operations/${op.id}/dispatch`, {}, `dispatch:${op.id}`); await refresh(r.id); })} /></div>)}
              {view.reconciliationError && <p role="alert">Provider reconciliation unavailable or unsupported. Persisted reservation and refund history shown; capture still requires authenticated evidence.</p>}
              {sandbox && r.orderId && <div className="approval-panel"><strong>PAYPAL SANDBOX BUYER APPROVAL</strong><p>Approve with a sandbox personal buyer, then reconcile. Capture requires a fresh server GET.</p>{approvalLink(view.approveUrl) && <a href={approvalLink(view.approveUrl)!} target="_blank" rel="noopener noreferrer">Approve on PayPal sandbox ↗</a>}<button disabled={disabled} onClick={() => void run('Reading PayPal status',()=>reconcile(r.id))}>Read approval status</button></div>}
              {!sandbox && r.orderId && r.state === 'ORDER_CREATED' && <div className="approval-panel"><strong>SIMULATED PAYPAL APPROVAL</strong><p>This fixture button is not a PayPal checkout page. No real buyer account is used.</p>{approvalLink(view.approveUrl) && <a href={approvalLink(view.approveUrl)!} target="_blank" rel="noopener noreferrer">Inspect simulated approval details ↗</a>}<button disabled={disabled || !!unknown} onClick={() => void run('Simulating owner approval', async () => { await api.post(`/api/reservations/${r.id}/simulate-approval`, {}, `approve:${r.id}`); await reconcile(r.id); })}>Simulate approval & read status</button></div>}
              <button className="secondary" disabled={!connected || !!busy} onClick={() => void run('Reconciling known outcome', () => reconcile(r.id), false)}>Reconcile known outcome</button>
              {r.capturedMinor > 0 && <details className="refund-panel"><summary>Request a refund</summary><p className="caption">Select a capture from this reservation’s retained CAPTURE ledger evidence. The server calculates remaining headroom; restoration requires completed evidence and the original signed policy.</p>
                {!captureEvidence.length && <p>No matching capture evidence in the loaded ledger page. Read further ledger pages before preparing a refund.</p>}
                {!refundDraft && <button className="secondary" disabled={disabled || !captureEvidence.length || !!r.anomalyReasons.length} onClick={newRefundIntent}>Start refund draft for this reservation</button>}
                {refundDraft && refundDraft.reservationId === r.id && <>
                  <code className="identity">Refund intent {refundDraft.intentId} · reservation {refundDraft.reservationId}</code>
                  <label htmlFor="retained-capture">Retained capture</label><select id="retained-capture" disabled={disabled || refundDraft.sent} value={refundDraft.captureId} onChange={e => putRefundDraft({ ...refundDraft, captureId: e.target.value, inspected: null })}><option value="">Choose capture evidence</option>{captureEvidence.map(row => <option key={row.paypal!['captureId']} value={row.paypal!['captureId']}>{row.paypal!['captureId']} · {money(row.amountMinor)} captured</option>)}</select>
                  {selectedCapture && <p>Target <code>{refundDraft.captureId}</code> · captured {money(selectedCapture.amountMinor)} · reservation <code>{r.id}</code></p>}
                  <label>Refund amount · USD<input disabled={disabled || refundDraft.sent} inputMode="decimal" value={refundDraft.amountText} onChange={e => putRefundDraft({ ...refundDraft, amountText: e.target.value, inspected: null })} placeholder="Blank = full remaining server headroom" /></label>
                  <p>Requested {refundDraft.amountText ? `${refundDraft.amountText} USD` : 'full remaining headroom, calculated by the server'}.</p>
                  <button disabled={disabled || refundDraft.sent || !selectedCapture || !!r.anomalyReasons.length || !!unknown} onClick={() => void run(paymentLabels(sandbox).refund, prepareRefund)}>{paymentLabels(sandbox).refund}</button>
                  {refundDraft.sent && <><p>This intent was submitted. Its key and amount are retained; a missing response, pending state or unknown outcome cannot create a replacement refund.</p><button className="secondary" disabled={!connected || !!busy} onClick={() => void run('Inspecting retained refund outcome', () => refresh(r.id), false)}>Read retained refund outcome</button>
                    {priorTerminal && <><p>Prior terminal outcome: <code>{priorTerminal.id}</code> · {priorTerminal.state} · {money(priorTerminal.amount)} · <code>{priorTerminal.providerRefundId ?? 'No provider refund ID reported'}</code></p><label className="confirm"><input type="checkbox" disabled={disabled} checked={refundDraft.inspected === refundEvidenceIdentity(priorTerminal)} onChange={e => putRefundDraft({ ...refundDraft, inspected: e.target.checked ? refundEvidenceIdentity(priorTerminal) : null })} />I inspected this prior terminal refund outcome.</label><button className="secondary" disabled={disabled || refundDraft.inspected !== refundEvidenceIdentity(priorTerminal)} onClick={newRefundIntent}>Start a new refund intent</button></>}
                  </>}
                </>}
                {view.refunds.map(f => <p key={f.id}>{money(f.amount)} · {f.state} · capture <code>{f.captureId}</code> · <code>{f.providerRefundId ?? f.id}</code></p>)}
              </details>}
            </> : <div className="empty-state"><span>↗</span><h3>No reservation selected.</h3><p>Reserve a reviewed cart, or load an existing reservation. Reading status never sends a payment.</p></div>}
          </section></div>
          <details className="panel concurrency"><summary>Concurrency demo · two distinct reviewed reserve requests</summary><p>Evaluate two distinct proposals, review each exact cart and policy, then explicitly submit both. Both may reserve funds. Results come from service transactions.</p><button className="secondary" disabled={disabled || !policy} onClick={() => void run('Evaluating two independent carts', () => evaluate('pair'))}>Evaluate two test carts</button>
            {reviews.length === 2 && <><div className="two-column">{reviews.map(renderReview)}</div><button disabled={disabled || !reviews.every(eligible) || !!budget?.spendBlocked} onClick={() => void run('Sending two reviewed reserve requests', async () => {
              const pair = reviewsRef.current; if (pair.length !== 2 || !pair.every(eligible)) throw new ApiError('Review and confirm both exact snapshots again.');
              const results = await Promise.allSettled(pair.map(review => reserve(review)));
              setConcurrencyResults(results.map((entry, i) => `Cart ${i + 1}: ${entry.status === 'fulfilled' ? `${entry.value.state} · ${money(entry.value.amount)} · ${entry.value.id}` : entry.reason instanceof Error ? entry.reason.message.slice(0, 320) : 'Refused'}`));
              if (results.some(entry => entry.status === 'rejected' && entry.reason instanceof ApiError && entry.reason.uncertain)) lockUnknown();
              await refresh();
            })}>Reserve both reviewed test carts</button></>}
            {concurrencyResults.map((value, i) => <p key={i}>{value}</p>)}
          </details>
        </>}
        {page === 'ledger' && <><LedgerGrid rows={rows} totals={budget} /><div className="button-row"><button className="secondary" disabled={!connected || !!busy} onClick={() => void run('Refreshing ledger', () => refresh(), false)}>Refresh server snapshot</button><button className="secondary" disabled={!connected || !hasMore || !!busy || rows.length >= 10000} onClick={() => void run('Reading next ledger page', async () => { const value = await api.get(`/api/ledger?since=${nextSince}`); const next = value['rows'] as LedgerRow[]; setRows(current => [...current, ...next]); setNextSince(Number(value['nextSince'])); setHasMore(next.length === 100); }, false)}>Load next 100</button><small className="subtle">{rows.length} retained rows shown · bounded to 10,000 per page session</small></div><details className="panel"><summary>Provider identifiers in retained evidence</summary>{rows.filter(row => row.reservationId).slice(-20).map(row => <p key={row.seq}><code>{row.reservationId}</code> · {row.kind} · {row.note} · <code>{Object.entries(row.paypal ?? {}).map(([kind, id]) => `${kind}: ${id}`).join(' · ')}</code></p>)}<p className="caption">Provider IDs are server-retained evidence. No ID is inferred from a status label.</p></details></>}
        {page === 'reconcile' && <div className="two-column"><section className="panel"><p className="eyebrow">BOUNDED / GET-ONLY RECOVERY</p><h2>Read outcomes. Never resend money.</h2><p>Recovery can inspect a known order, capture or refund. A missing resource ID or a 404 is not proof that a payment failed.</p><dl className="facts"><div><dt>Startup recovery</dt><dd>{String(health?.['startupRecovery'] ?? 'Unknown')}</dd></div><div><dt>Last requested run</dt><dd>{lastReconcile || 'Not run in this session'}</dd></div><div><dt>Payment retries</dt><dd>Disabled · one send claim</dd></div><div><dt>Unknown money</dt><dd>Retained for review</dd></div></dl><button disabled={!connected || !!busy} onClick={() => void run('Running bounded reconciliation', () => reconcile(), false)}>Reconcile known resources →</button>{reconcileResult && <div className="reconcile-result">{(['checked', 'changed', 'anomalies', 'deferred'] as const).map(key => <div key={key}><strong>{String(reconcileResult[key] ?? 'Unknown')}</strong><small>{key}</small></div>)}</div>}<p className="caption">Automatic recovery retains its original horizon and attempt count. Manual review never means “safe to send again.”</p><p>Per-subject provider state is unavailable in this API response. Selected reservation and operation states remain available on Cart; no provider comparison is inferred.</p></section><section className="panel"><p className="eyebrow">VERIFICATION BOUNDARY</p><h2>Hints are not money facts.</h2><p>Localhost release uses GET reconciliation; public HTTPS webhook delivery and PayPal verification are not implemented. Those deliveries remain UNVERIFIED and cannot authorize a payment.</p><p>The integration check uses a separate injected fixture HMAC protocol. It is not PayPal certificate verification.</p><div className="empty-state"><span>◎</span><h3>Inbox viewer not connected.</h3><p>This API does not yet expose a bounded inbox read route. No invented webhook rows or verification badges are shown.</p></div></section></div>}
        <footer><span>MANDATE LEDGER · {sandbox?'PAYPAL SANDBOX':'FIXTURE'} WORKSPACE</span><span>Server counters. Explicit permission. Evidence before certainty.</span></footer>
      </main>
    </div>
    <dialog ref={dialogRef} className="step-up-dialog" aria-modal="true" aria-labelledby="step-up-title" aria-describedby="step-up-description" onCancel={event => { event.preventDefault(); if (modalReview) consent(modalReview, false); setModalReview(null); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }}>
      {modalReview && <><h2 id="step-up-title">Confirm this exact cart</h2><p id="step-up-description">This cart reaches the step-up threshold. Confirmation authorizes only this displayed proposal and policy snapshot; the service checks them again.</p><code className="identity">Proposal {modalReview.proposal.proposalId}<br />Policy v{modalReview.verdict.policyVersion} · {modalReview.verdict.policyHash}</code><ul>{modalReview.verdict.lines.map((line, i) => <li key={i}>{line.qty} × {line.sku} · {money(line.lineTotalMinor)}</li>)}</ul><p><strong>Total {money(modalReview.verdict.orderTotalMinor)}</strong> including {money(modalReview.verdict.shippingMinor)} shipping</p><div className="button-row"><button ref={cancelRef} className="secondary" onClick={() => { consent(modalReview, false); setModalReview(null); }}>Cancel</button><button disabled={disabled || !reviewCurrent(modalReview) || !reservable(modalReview)} onClick={() => { if (!reviewCurrent(modalReview)) return; consent(modalReview, true); setModalReview(null); }}>Confirm reviewed step-up</button></div></>}
    </dialog>
  </div>;
}
