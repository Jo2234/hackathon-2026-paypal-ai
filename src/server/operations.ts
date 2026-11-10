import { randomUUID } from 'node:crypto';
import type { Db } from './db/db.ts';
import { systemClock,serverNow } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import type { TransactionTiming } from './db/db.ts';
import { assertTransaction,withImmediate } from './db/db.ts';
import { activePolicy, all, audit, blockOwner, budget, int, one, operation, refund, reservation, run, saveReservation, text } from './db/repo.ts';
import type { Operation, OperationKind } from '../shared/types.ts';
import { assertUuidV4,canonicalJson,hashJson } from '../shared/canonical.ts';
import { LIMITS } from '../shared/limits.ts';
import { weeklyPeriod } from '../domain/ledger/period.ts';
export function createOperation(db:Db,kind:OperationKind,subjectId:string,body:unknown,now:number,expiresAt:number):Operation {
  const old=one(db,'SELECT id,body_hash FROM operations WHERE kind=? AND subject_id=?',kind,subjectId);
  if(old) { if(text(old,'body_hash')!==hashJson(body)) throw new Error('OPERATION_BODY_CONFLICT'); return operation(db,text(old,'id')); }
  if(int(one(db,"SELECT COUNT(*) AS n FROM operations WHERE state IN('READY','SENDING')")!,'n')>=LIMITS.queue) throw new Error('COMMAND_QUEUE_FULL_503');
  const id=randomUUID(), requestId=randomUUID(); assertUuidV4(requestId);
  run(db,"INSERT INTO operations(id,kind,subject_id,request_id,canonical_body,body_hash,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'READY',?,?,?)",id,kind,subjectId,requestId,canonicalJson(body),hashJson(body),Math.min(now+LIMITS.readyMs,expiresAt),now,now);
  return operation(db,id);
}
// This module owns permit creation. Reading a durable row/token is never a permit.
export type SendPermit = Readonly<{ operationId:string }>;
const permits = new WeakMap<SendPermit,Readonly<{operation:Operation;clock:ServerClock;deadlineMono:number}>>();
export type ClaimInput = Readonly<{ sessionDeadlineMono:number;sessionExpiresAt:number; approval?:Readonly<{orderId:string;observedAt:number;status:'APPROVED';amountMinor:number;merchantId:string}> }>;
export async function claimOperation(db:Db,id:string,input:ClaimInput,timing:TransactionTiming={}):Promise<SendPermit|null> {
  const clock=timing.clock??systemClock;
  const parentDeadlineMono=Math.min(input.sessionDeadlineMono,timing.parentDeadlineMono??Infinity);
  const claimed=await withImmediate(db,()=>{
    const op=operation(db,id); const now=serverNow(clock),claimMono=clock.monotonicNow();
    if(!Number.isSafeInteger(input.sessionExpiresAt) || !Number.isFinite(input.sessionDeadlineMono))throw new Error('SESSION_DEADLINE_INVALID');
    const remaining=Math.min(parentDeadlineMono-claimMono,input.sessionExpiresAt-now);
    if(op.state!=='READY' || op.attempt!==0) return null;
    const sendBudgetMs=Math.floor(Math.min(LIMITS.post.claimMs,remaining));
    if(!Number.isSafeInteger(now) || sendBudgetMs<1 || now>=op.expiresAt || now<op.createdAt) throw new Error('CLAIM_DEADLINE');
    if(op.kind==='REFUND_CREATE') {
      const f=refund(db,op.subjectId); const r=reservation(db,f.reservationId);
      if(f.state!=='REQUESTED' || r.anomalyReasons.length) throw new Error('REFUND_CLAIM_BLOCKED');
      run(db,"UPDATE refunds SET state='SUBMITTING',updated_at=? WHERE id=? AND state='REQUESTED'",now,f.id);
    } else {
      const r=reservation(db,op.subjectId); const p=activePolicy(db,r.ownerId);
      if(!p || p.mandateId!==r.mandateId || p.version!==r.policyVersion || p.contentHash!==r.policyHash || !Number.isFinite(Date.parse(p.expiresAt)) || now>=Date.parse(p.expiresAt) || r.periodKey!==weeklyPeriod(now).periodKey || now<r.createdAt || now>=r.createdAt+LIMITS.reservationMs || budget(db,r.ownerId,r.periodKey).spendBlocked || r.holdMinor===0 || r.capturedMinor>0) throw new Error('MANDATE_NOT_ACTIVE');
      if(op.kind==='ORDER_CAPTURE') {
        const a=input.approval;
        if(r.state!=='APPROVED' || !a || a.orderId!==r.orderId || a.status!=='APPROVED' || a.amountMinor!==r.amount || a.merchantId!==p.merchantId || !Number.isSafeInteger(a.observedAt) || a.observedAt>now || now-a.observedAt>LIMITS.freshApprovalMs) throw new Error('FRESH_APPROVAL_REQUIRED');
        saveReservation(db,{...r,state:'CAPTURING',updatedAt:now});
      } else { if(r.state!=='HELD') throw new Error('BAD_CREATE_STATE'); saveReservation(db,{...r,state:'CREATING',updatedAt:now}); }
      audit(db,r,'RECONCILE',0,now,`${op.kind} send claim; earlier claim may send or settle after revoke`);
    }
    const token=randomUUID();
    const changed=run(db,"UPDATE operations SET state='SENDING',attempt=1,owner_token=?,claimed_at=?,send_deadline=?,first_attempt_at=?,horizon_until=?,next_get_at=?,updated_at=? WHERE id=? AND state='READY' AND attempt=0",token,now,now+sendBudgetMs,now,now+LIMITS.autoGet.horizonMs,now+LIMITS.autoGet.initialIntervalMs,now,id);
    if(changed!==1) throw new Error('CLAIM_CAS_LOST');
    return {operation:operation(db,id),deadlineMono:claimMono+sendBudgetMs};
  },{...timing,clock,parentDeadlineMono});
  if(!claimed) return null;
  const permit=Object.freeze({operationId:id}); permits.set(permit,{...claimed,clock}); return permit;
}
// Consume immediately before the S2 transport invocation; no I/O is implemented here.
export function consumeSendPermit(permit:SendPermit):Operation {
  const stored=permits.get(permit); permits.delete(permit);
  if(!stored)throw new Error('SEND_PERMIT_SPENT_OR_EXPIRED');
  const {operation:op,clock,deadlineMono}=stored;const now=serverNow(clock);
  if(clock.monotonicNow()>=deadlineMono || op.sendDeadline===null || op.claimedAt===null || now<op.claimedAt || now>=op.sendDeadline) throw new Error('SEND_PERMIT_SPENT_OR_EXPIRED');
  return op;
}
export function markUnknown(db:Db,id:string,now:number,diagnostic?:'PAYPAL_REFUND_CORRELATION_MISMATCH'):void {
  const op=operation(db,id);
  if(op.state!=='SENDING') return;
  // Only this fixed refund diagnostic can replace the generic ambiguity label.
  // Never persist arbitrary exception messages or provider bodies.
  const mismatch=op.kind==='REFUND_CREATE' && diagnostic==='PAYPAL_REFUND_CORRELATION_MISMATCH';
  run(db,"UPDATE operations SET state='UNKNOWN',last_error=?,updated_at=? WHERE id=? AND state='SENDING'",mismatch?'PAYPAL_REFUND_CORRELATION_MISMATCH':'ambiguous outcome; GET absence is not noncommit proof',now,id);
  if(op.kind==='REFUND_CREATE') {
    const f=refund(db,op.subjectId);const r=reservation(db,f.reservationId);blockOwner(db,r.ownerId,`UNKNOWN_OPERATION:${id}`);
    run(db,"UPDATE refunds SET state='REFUND_UNKNOWN',updated_at=? WHERE id=? AND completed_applied=0 AND state='SUBMITTING'",now,op.subjectId);
    // Existing ledger UI renders notes; this is diagnostic evidence, never refund credit.
    if(mismatch)audit(db,r,'RECONCILE',0,now,'PAYPAL_REFUND_CORRELATION_MISMATCH');
  }
  else {
    const r=reservation(db,op.subjectId);blockOwner(db,r.ownerId,`UNKNOWN_OPERATION:${id}`);
    if(r.holdMinor>0 && r.capturedMinor===0) saveReservation(db,{...r,state:op.kind==='ORDER_CAPTURE'?'CAPTURE_UNKNOWN':'CREATE_UNKNOWN',updatedAt:now});
  }
}
export function recoverExpiredSending(db:Db,clock:ServerClock=systemClock):number {
  assertTransaction(db);const now=serverNow(clock);
  const rows=all(db,"SELECT id FROM operations WHERE state='SENDING' AND send_deadline<=? ORDER BY created_at LIMIT 100",now);
  for(const row of rows) markUnknown(db,text(row,'id'),now);
  return rows.length;
}
// Call once BEFORE EACH actual HTTP GET, including a transport's second retry.
// No resource id => no attempt. Absence/404 never updates monetary state.
export function claimAutomaticGetAttempt(db:Db,id:string,resourceId:string|null,clock:ServerClock=systemClock,continuation=false):boolean {
  assertTransaction(db);const now=serverNow(clock);
  const op=operation(db,id);
  if(!['UNKNOWN','SENDING'].includes(op.state) || op.claimedAt===null || op.horizonUntil===null) return false;
  const last=one(db,'SELECT last_get_at FROM operations WHERE id=?',id)!;
  if(now<op.claimedAt || (last['last_get_at']!==null && now<int(last,'last_get_at')) || now>=op.horizonUntil || op.getAttempts>=LIMITS.autoGet.attempts) {
    run(db,"UPDATE operations SET state='MANUAL',updated_at=? WHERE id=? AND state IN('UNKNOWN','SENDING')",now,id); return false;
  }
  if(!resourceId || (!continuation && op.nextGetAt!==null && now<op.nextGetAt)) return false;
  const interval=op.getAttempts+1>=5?LIMITS.autoGet.laterIntervalMs:LIMITS.autoGet.initialIntervalMs;
  return run(db,"UPDATE operations SET get_attempts=get_attempts+1,last_get_at=?,next_get_at=?,updated_at=? WHERE id=? AND get_attempts<24 AND horizon_until>? AND state IN('UNKNOWN','SENDING')",now,now+interval,now,id,now)===1;
}
// No-claim expiry only. Capture/create hold release uses the same ledger release helper;
// this primitive cancels a refund commitment which never acquired any send claim.
export function expireUnclaimedRefundOperations(db:Db,clock:ServerClock=systemClock):number {
  assertTransaction(db);const now=serverNow(clock);
  const rows=all(db,"SELECT id,subject_id FROM operations WHERE kind='REFUND_CREATE' AND state='READY' AND attempt=0 AND expires_at<=? LIMIT 100",now);
  for(const row of rows) {
    run(db,"UPDATE operations SET state='FAILED_DEFINITIVE',last_error='expired before send claim',updated_at=? WHERE id=? AND state='READY' AND attempt=0",now,text(row,'id'));
    const f=refund(db,text(row,'subject_id'));
    if(run(db,"UPDATE refunds SET state='CANCELLED',updated_at=? WHERE id=? AND state='REQUESTED' AND completed_applied=0",now,f.id)===1) audit(db,reservation(db,f.reservationId),'REFUND_FAIL',f.amount,now,'Expired before claim; local commitment cancelled');
  }
  return rows.length;
}
// S2 lifecycle mapping: a valid PENDING capture/refund is NOT operation DONE.
// UNKNOWN here means terminal write outcome unresolved; domain state still exposes provider-pending.
// Preserve the original horizon/attempts; MANUAL is never reset by pending evidence.
export function recordOperationPending(db:Db,id:string,clock:ServerClock=systemClock):void {
  assertTransaction(db);const now=serverNow(clock);
  run(db,"UPDATE operations SET state='UNKNOWN',updated_at=? WHERE id=? AND attempt=1 AND state IN('SENDING','UNKNOWN')",now,id);
}
// Finite positive-fact primitive only; S2 response/GET transport mapping is still absent.
// The reducer owns money. This helper only closes the original claimed refund operation;
// late facts may be applied independently, but never silently reset MANUAL/failed work.
export function recordRefundOperationCompleted(db:Db,id:string,ownerToken:string,providerRefundId:string,clock:ServerClock=systemClock):void {
  assertTransaction(db);
  const op=operation(db,id);
  if(op.kind!=='REFUND_CREATE' || op.attempt!==1 || typeof ownerToken!=='string' || !ownerToken || op.ownerToken!==ownerToken || !['SENDING','UNKNOWN','MANUAL','DONE'].includes(op.state)) throw new Error('REFUND_OPERATION_COMPLETION_NOT_OWNED');
  const f=refund(db,op.subjectId);
  if(typeof providerRefundId!=='string' || !/^[A-Za-z0-9-]{1,128}$/.test(providerRefundId) || f.providerRefundId!==providerRefundId) throw new Error('REFUND_OPERATION_COMPLETION_ID_MISMATCH');
  // Bind the positive fact to this immutable operation subject, local refund, capture,
  // reservation, exact amount and USD currency. No caller-supplied completion flag.
  const positive=one(db,"SELECT 1 FROM refunds f JOIN provider_refund_facts p ON p.refund_id=f.provider_refund_id AND p.local_refund_id=f.id JOIN provider_captures c ON c.capture_id=f.capture_id JOIN reservations r ON r.id=f.reservation_id WHERE f.id=? AND f.state='COMPLETED' AND f.completed_applied=1 AND p.completion_observed=1 AND p.capture_id=f.capture_id AND p.amount_minor=f.amount AND p.currency='USD' AND c.reservation_id=r.id AND c.currency=p.currency AND c.completion_observed=1",op.subjectId);
  if(!positive) throw new Error('REFUND_OPERATION_COMPLETION_FACT_REQUIRED');
  if(op.state==='DONE') return; // Same owner, subject and positively correlated completion only.
  const now=serverNow(clock);
  if(!Number.isSafeInteger(now)) throw new Error('REFUND_OPERATION_COMPLETION_CLOCK_INVALID');
  const changed=run(db,"UPDATE operations SET state='DONE',updated_at=? WHERE id=? AND kind='REFUND_CREATE' AND subject_id=? AND attempt=1 AND owner_token=? AND state=?",now,id,op.subjectId,ownerToken,op.state);
  if(changed!==1) throw new Error('REFUND_OPERATION_COMPLETION_CAS_LOST');
}
