import type { CaptureObservation, RefundObservation, Reservation } from '../../shared/types.ts';
import type { Db } from '../../server/db/db.ts';
import { assertTransaction, withImmediate } from '../../server/db/db.ts';
import { all, anomaly, audit, blockNegative, blockOwner, int, observation, one, refund, reservation, run, saveReservation, text } from '../../server/db/repo.ts';
import { canonicalJson } from '../../shared/canonical.ts';
import { addMinor, parseMinor } from '../money.ts';
import { reduceCapture, reduceRefund } from './state.ts';
const RESOURCE_ID = /^[A-Za-z0-9-]{1,128}$/;
function knownUsdAmount(db:Db,r:Reservation,currency:string,amount:string,now:number):number|null {
  if(currency!=='USD') { anomaly(db,r,'CURRENCY_MISMATCH',now);return null; }
  try { const value=parseMinor(amount,'USD'); if(value<=0) throw new Error('POSITIVE');return value; }
  catch { anomaly(db,r,'AMOUNT_OUT_OF_RANGE',now);return null; }
}
function overflow(db:Db,r:Reservation,values:readonly number[],now:number):boolean {
  try { addMinor(...values);return false; } catch { anomaly(db,r,'AMOUNT_OUT_OF_RANGE',now);return true; }
}
// Evidence is bounded/redacted by the future S2 adapter. No webhook-payload monetary path.
export function observeCapture(db:Db,reservationId:string,obs:CaptureObservation):Promise<void> {
  return withImmediate(db,()=>observeCaptureInTransaction(db,reservationId,obs));
}
// Synchronous composition only: caller owns the active IMMEDIATE transaction.
export function observeCaptureInTransaction(db:Db,reservationId:string,obs:CaptureObservation):void {
    assertTransaction(db);
    let r=reservation(db,reservationId);const now=obs.evidence.observedAt; observation(db,{...obs.evidence,boundedRedactedJson:canonicalJson({resourceId:obs.evidence.resourceId,currency:obs.currency.slice(0,64),amount:obs.amount.slice(0,512),status:obs.status,amountTruncated:obs.amount.length>512,rawPayloadHash:obs.evidence.payloadHash})});
    if(!RESOURCE_ID.test(obs.captureId) || !RESOURCE_ID.test(obs.orderId) || r.orderId!==obs.orderId) { anomaly(db,r,'ORDER_FOR_UNKNOWN_RESERVATION',now);return; }
    const amount=knownUsdAmount(db,r,obs.currency,obs.amount,now);if(amount===null)return;
    const prior=one(db,'SELECT * FROM provider_captures WHERE capture_id=?',obs.captureId);
    if(prior && (text(prior,'reservation_id')!==r.id || int(prior,'amount_minor')!==amount || text(prior,'order_id')!==obs.orderId)) { anomaly(db,r,'AMOUNT_CONTRADICTION',now);return; }
    const statusOwner=one(db,'SELECT reservation_id FROM capture_status_facts WHERE capture_id=? LIMIT 1',obs.captureId);
    if(statusOwner && text(statusOwner,'reservation_id')!==r.id) {
      anomaly(db,r,'ORDER_FOR_UNKNOWN_RESERVATION',now);
      anomaly(db,reservation(db,text(statusOwner,'reservation_id')),'ORDER_FOR_UNKNOWN_RESERVATION',now);return;
    }
    if(obs.status==='REVERSED') { anomaly(db,r,'PROVIDER_REVERSAL',now);return; }
    if(obs.status!=='COMPLETED') {
      if(prior) { if(obs.status==='DECLINED') anomaly(db,r,'CAPTURE_TERMINAL_CONTRADICTION',now);return; }
      // Preserve a denial for contradiction detection; future late completion still records money.
      run(db,'INSERT INTO capture_status_facts(capture_id,reservation_id,status) VALUES(?,?,?) ON CONFLICT(capture_id,status) DO NOTHING',obs.captureId,r.id,obs.status);
      if(obs.status==='PENDING' && r.holdMinor>0 && r.capturedMinor===0) saveReservation(db,{...r,state:'CAPTURE_PROVIDER_PENDING',updatedAt:now});
      if(obs.status==='DECLINED' && r.capturedMinor===0) {
        // A denial of another capture cannot resolve a known pending capture.
        if(one(db,"SELECT 1 FROM capture_status_facts WHERE reservation_id=? AND capture_id!=? AND status='PENDING'",r.id,obs.captureId)) { anomaly(db,r,'UNKNOWN_CAPTURE_ID',now);return; }
        run(db,'UPDATE budget_buckets SET reserved=reserved-? WHERE owner_id=? AND period_key=?',r.holdMinor,r.ownerId,r.periodKey);
        saveReservation(db,{...r,state:'RELEASED',holdMinor:0,updatedAt:now});
        audit(db,r,'RELEASE',r.holdMinor,now,'Positive correlated terminal capture denial',obs.evidence.source,{captureId:obs.captureId});
      }
      return;
    }
    if(prior) return;
    const bucket=one(db,'SELECT captured FROM budget_buckets WHERE owner_id=? AND period_key=?',r.ownerId,r.periodKey)!;
    if(overflow(db,r,[int(bucket,'captured'),amount],now) || overflow(db,r,[r.capturedMinor,amount],now)) return;
    const ids=all(db,'SELECT capture_id FROM provider_captures WHERE reservation_id=?',r.id).map(row=>text(row,'capture_id'));
    const reduced=reduceCapture(r,amount,ids,obs.captureId,now);
    run(db,'INSERT INTO provider_captures(capture_id,reservation_id,order_id,currency,amount_minor,completion_observed,raw_fact_hash) VALUES(?,?,?,\'USD\',?,1,?)',obs.captureId,r.id,obs.orderId,amount,obs.evidence.payloadHash);
    run(db,'UPDATE budget_buckets SET reserved=reserved-?,captured=captured+? WHERE owner_id=? AND period_key=?',reduced.holdReleased,amount,r.ownerId,r.periodKey);
    saveReservation(db,reduced.reservation);r=reduced.reservation;
    for(const reason of reduced.reasons) blockOwner(db,r.ownerId,reason);
    if(one(db,"SELECT 1 FROM capture_status_facts WHERE capture_id=? AND status='DECLINED'",obs.captureId)) anomaly(db,r,'CAPTURE_TERMINAL_CONTRADICTION',now);
    blockNegative(db,r);
    audit(db,r,'CAPTURE',amount,now,'Unique gross completed capture; hold converts at most once',obs.evidence.source,{captureId:obs.captureId,orderId:obs.orderId});
}
export function observeRefund(db:Db,obs:RefundObservation,localRefundId:string|null):Promise<void> {
  return withImmediate(db,()=>observeRefundInTransaction(db,obs,localRefundId));
}
// Preserve the same reducer, CAS, audit and quarantine semantics as the public wrapper.
export function observeRefundInTransaction(db:Db,obs:RefundObservation,localRefundId:string|null):void {
    assertTransaction(db);
    observation(db,{...obs.evidence,boundedRedactedJson:canonicalJson({resourceId:obs.evidence.resourceId,currency:obs.currency.slice(0,64),amount:obs.amount.slice(0,512),status:obs.status,amountTruncated:obs.amount.length>512,rawPayloadHash:obs.evidence.payloadHash})});
    const cap=one(db,'SELECT * FROM provider_captures WHERE capture_id=?',obs.captureId);
    // Correlation to an owner is required; caller quarantines owner-known but unlinked resources.
    if(!cap) throw new Error('UNKNOWN_CAPTURE_CORRELATION_REQUIRED');
    let r=reservation(db,text(cap,'reservation_id'));const now=obs.evidence.observedAt;
    if(!RESOURCE_ID.test(obs.refundId)) { anomaly(db,r,'AMOUNT_CONTRADICTION',now);return; }
    const amount=knownUsdAmount(db,r,obs.currency,obs.amount,now);if(amount===null)return;
    const prior=one(db,'SELECT * FROM provider_refund_facts WHERE refund_id=?',obs.refundId);
    if(prior && (text(prior,'capture_id')!==obs.captureId || int(prior,'amount_minor')!==amount || (localRefundId!==null && prior['local_refund_id']!==null && text(prior,'local_refund_id')!==localRefundId))) { anomaly(db,r,'AMOUNT_CONTRADICTION',now);return; }
    const boundLocal=one(db,'SELECT id FROM refunds WHERE provider_refund_id=?',obs.refundId);
    if(boundLocal && localRefundId!==null && text(boundLocal,'id')!==localRefundId) { anomaly(db,r,'AMOUNT_CONTRADICTION',now);return; }
    const correlatedLocalId=localRefundId??(boundLocal?text(boundLocal,'id'):null)??(prior && prior['local_refund_id']!==null?text(prior,'local_refund_id'):null);
    if(correlatedLocalId===null) {
      if(obs.status!=='COMPLETED' || prior) return;
      const b=one(db,'SELECT external_refunded FROM budget_buckets WHERE owner_id=? AND period_key=?',r.ownerId,r.periodKey)!;
      if(overflow(db,r,[int(b,'external_refunded'),amount],now) || overflow(db,r,[r.externalRefundedMinor,amount],now))return;
      run(db,'INSERT INTO provider_refund_facts(refund_id,capture_id,currency,amount_minor,completion_observed,raw_fact_hash) VALUES(?,?,\'USD\',?,1,?)',obs.refundId,obs.captureId,amount,obs.evidence.payloadHash);
      run(db,'UPDATE budget_buckets SET external_refunded=external_refunded+? WHERE owner_id=? AND period_key=?',amount,r.ownerId,r.periodKey);
      saveReservation(db,{...r,externalRefundedMinor:addMinor(r.externalRefundedMinor,amount),updatedAt:now});
      r=reservation(db,r.id);anomaly(db,r,'UNMATCHED_PROVIDER_REFUND',now);audit(db,r,'REFUND_DONE',amount,now,'External completed refund; no restoration',obs.evidence.source,{refundId:obs.refundId});
    } else {
      const f=refund(db,correlatedLocalId);
      if(f.captureId!==obs.captureId || f.reservationId!==r.id || f.amount!==amount || (f.providerRefundId!==null && f.providerRefundId!==obs.refundId)) { anomaly(db,r,'AMOUNT_CONTRADICTION',now);return; }
      const reduced=reduceRefund(f,obs.status,r.restoration==='restore_on_completed_refund',now);
      if(reduced.contradiction) { anomaly(db,r,'REFUND_TERMINAL_CONTRADICTION',now);r=reservation(db,r.id); }
      if(obs.status==='COMPLETED' && !f.completedApplied) {
        const b=one(db,'SELECT refunded_completed,restored FROM budget_buckets WHERE owner_id=? AND period_key=?',r.ownerId,r.periodKey)!;
        if(overflow(db,r,[int(b,'refunded_completed'),amount],now) || overflow(db,r,[int(b,'restored'),reduced.restoredAdded],now))return;
        // This CAS controls BOTH budget increments and their money audit rows.
        const changed=run(db,"UPDATE refunds SET state='COMPLETED',completed_applied=1,provider_refund_id=?,updated_at=? WHERE id=? AND completed_applied=0",obs.refundId,now,f.id);
        if(changed!==1)return;
        if(!prior) run(db,'INSERT INTO provider_refund_facts(refund_id,capture_id,currency,amount_minor,completion_observed,local_refund_id,raw_fact_hash) VALUES(?,?,\'USD\',?,1,?,?)',obs.refundId,obs.captureId,amount,f.id,obs.evidence.payloadHash);
        else if(prior['local_refund_id']===null) {
          run(db,'UPDATE provider_refund_facts SET local_refund_id=? WHERE refund_id=? AND local_refund_id IS NULL',f.id,obs.refundId);
          run(db,'UPDATE budget_buckets SET external_refunded=external_refunded-? WHERE owner_id=? AND period_key=?',amount,r.ownerId,r.periodKey);
          saveReservation(db,{...r,externalRefundedMinor:addMinor(r.externalRefundedMinor,-amount),updatedAt:now});
        }
        run(db,'UPDATE budget_buckets SET refunded_completed=refunded_completed+?,restored=restored+? WHERE owner_id=? AND period_key=?',amount,reduced.restoredAdded,r.ownerId,r.periodKey);
        audit(db,r,'REFUND_DONE',amount,now,'First completion CAS; original reservation period',obs.evidence.source,{refundId:obs.refundId});
        if(reduced.restoredAdded) audit(db,r,'RESTORE',amount,now,'Restoration credits only original reservation period',obs.evidence.source,{refundId:obs.refundId});
      } else if(!f.completedApplied && reduced.refund.state!==f.state) {
        run(db,'UPDATE refunds SET state=?,provider_refund_id=?,updated_at=? WHERE id=? AND completed_applied=0',reduced.refund.state,obs.refundId,now,f.id);
        if(obs.status==='FAILED' || obs.status==='CANCELLED') audit(db,r,'REFUND_FAIL',amount,now,'Positive correlated terminal refund observation',obs.evidence.source,{refundId:obs.refundId});
      }
    }
    const completed=int(one(db,'SELECT COALESCE(SUM(amount_minor),0) AS n FROM provider_refund_facts WHERE capture_id=?',obs.captureId)!,'n');
    const committed=int(one(db,"SELECT COALESCE(SUM(amount),0) AS n FROM refunds WHERE capture_id=? AND state IN('REQUESTED','SUBMITTING','PROVIDER_PENDING','REFUND_UNKNOWN')",obs.captureId)!,'n');
    if(BigInt(completed)+BigInt(committed)>BigInt(int(cap,'amount_minor'))) anomaly(db,reservation(db,r.id),'REFUND_OVER_CAPTURE',now);
}
// Acknowledgement is metadata only. It cannot clear a block, hold or refund commitment.
export function acknowledge(db:Db,reservationId:string,now:number):Promise<void> {
  return withImmediate(db,()=>{const r=reservation(db,reservationId);audit(db,r,'DISPOSITION',0,now,'Acknowledged; unresolved money and owner block retained');});
}
export function quarantineUnlinked(db:Db,ownerId:string,evidence:CaptureObservation['evidence']):Promise<void> {
  return withImmediate(db,()=>{observation(db,evidence);blockOwner(db,ownerId,'ORDER_FOR_UNKNOWN_RESERVATION');});
}
