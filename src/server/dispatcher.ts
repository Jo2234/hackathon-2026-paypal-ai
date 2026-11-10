import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from './db/db.ts';
import { assertTransaction, withImmediate } from './db/db.ts';
import { anomaly, audit, blockOwner, int, json, observation, one, operation, refund, reservation, run, saveReservation, text } from './db/repo.ts';
import { claimOperation, consumeSendPermit, markUnknown, recordOperationPending, recordRefundOperationCompleted } from './operations.ts';
import { observeCaptureInTransaction, observeRefundInTransaction } from '../domain/ledger/facts.ts';
import { parseMinor } from '../domain/money.ts';
import { canonicalJson, hashJson } from '../shared/canonical.ts';
import { serverNow, systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import { LIMITS } from '../shared/limits.ts';
import type { FactEvidence, Operation } from '../shared/types.ts';
import type { Deadline } from '../shared/io-contracts.ts';
import { assertDeadline, deadlineScope } from './session.ts';
import { FailureLatch } from './request-control.ts';
import type { OwnerSession } from './session.ts';
import { resourceId, validateResource } from './paypal/provider.ts';
import type { CaptureResource, PayPalProvider, OrderResource, ProviderResource, RefundResource } from './paypal/provider.ts';

export class FixtureDispatcher {
  readonly db:Db;
  readonly provider:PayPalProvider;
  readonly clock:ServerClock;
  private sending=false;
  readonly failures:FailureLatch;
  constructor(db:Db,provider:PayPalProvider,clock:ServerClock=systemClock,failures=new FailureLatch()) { this.db=db;this.provider=provider;this.clock=clock;this.failures=failures;
    // Legacy totals remain an audit counter only; never reset or repurpose them.
    // Purpose comes from server code, never a route body. Nested GETs/retries carry it.
    if(provider.bindGetAdmission){
      db.exec(`CREATE TABLE IF NOT EXISTS wire_get_budget(path TEXT PRIMARY KEY,started INTEGER NOT NULL,last_at INTEGER NOT NULL,attempts INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS wire_get_lanes(path TEXT NOT NULL,purpose TEXT NOT NULL,started INTEGER NOT NULL,last_at INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(path,purpose)) STRICT;
        CREATE TABLE IF NOT EXISTS wire_get_admissions(seq INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL,purpose TEXT NOT NULL,admitted_at INTEGER NOT NULL) STRICT;`);
      provider.bindGetAdmission(async (path,purpose)=>withImmediate(db,()=>{
        const now=serverNow(clock),prior=one(db,'SELECT * FROM wire_get_lanes WHERE path=? AND purpose=?',path,purpose);
        if(prior && now<int(prior,'last_at'))throw new Error('GET_RESOURCE_CLOCK_ROLLBACK');
        const automatic=purpose==='automatic';
        const windowMs=purpose==='callback'?LIMITS.wireGet.callbackWindowMs:automatic?LIMITS.autoGet.horizonMs:purpose==='manual'?LIMITS.wireGet.manualWindowMs:LIMITS.wireGet.foregroundWindowMs;
        const cap=purpose==='callback'?LIMITS.wireGet.callbackAttempts:automatic?LIMITS.autoGet.attempts:purpose==='manual'?LIMITS.wireGet.manualAttempts:LIMITS.wireGet.foregroundAttempts;
        const expired=!!prior && now-int(prior,'started')>=windowMs;
        if(automatic && expired)throw new Error('GET_RESOURCE_HORIZON_EXHAUSTED');
        if(prior && !expired && int(prior,'attempts')>=cap)throw new Error('GET_RESOURCE_BUDGET_EXHAUSTED');
        run(db,'INSERT INTO wire_get_lanes VALUES(?,?,?,?,1) ON CONFLICT(path,purpose) DO UPDATE SET started=excluded.started,last_at=excluded.last_at,attempts=?',path,purpose,prior&&!expired?int(prior,'started'):now,now,prior&&!expired?int(prior,'attempts')+1:1);
        run(db,'INSERT INTO wire_get_budget VALUES(?,?,?,1) ON CONFLICT(path) DO UPDATE SET last_at=excluded.last_at,attempts=wire_get_budget.attempts+1',path,now,now);
        run(db,'INSERT INTO wire_get_admissions(path,purpose,admitted_at) VALUES(?,?,?)',path,purpose,now);
      },{clock}));
    }
  }

  private evidence(resource:ProviderResource):FactEvidence {
    const amount='amount' in resource?resource.amount:resource.purchase_units[0]!.amount;
    return {resourceId:resource.id,payloadHash:hashJson(resource),boundedRedactedJson:canonicalJson({resourceId:resource.id,status:resource.status,currency:amount.currency_code,amount:amount.value,payloadHash:hashJson(resource),...('debugId' in resource?{debugId:resource.debugId}:{})}),source:this.provider.mode,observedAt:serverNow(this.clock)};
  }
  // Token/attempt/subject fence applies only to lifecycle closure. Authentic late
  // facts still reduce, including MANUAL/failed operations; those states never reset.
  private closable(op:Operation):boolean {
    assertTransaction(this.db);
    const current=operation(this.db,op.id);
    return op.attempt===1 && !!op.ownerToken && current.attempt===1 && current.ownerToken===op.ownerToken && current.kind===op.kind && current.subjectId===op.subjectId && current.requestId===op.requestId && current.bodyHash===op.bodyHash && ['SENDING','UNKNOWN','MANUAL','DONE'].includes(current.state);
  }
  private finish(op:Operation,state:'DONE'|'FAILED_DEFINITIVE'):void {
    assertTransaction(this.db);
    if(!this.closable(op)) return;
    const current=operation(this.db,op.id);
    if(current.state==='DONE' && state!=='DONE')return;
    if(current.state!=='DONE') {
      const changed=run(this.db,"UPDATE operations SET state=?,updated_at=? WHERE id=? AND kind=? AND subject_id=? AND owner_token=? AND attempt=1 AND state=?",state,serverNow(this.clock),op.id,op.kind,op.subjectId,op.ownerToken,current.state);
      if(changed!==1)throw new Error('OPERATION_RESULT_CAS_LOST');
    }
    const r=reservation(this.db,op.kind==='REFUND_CREATE'?refund(this.db,op.subjectId).reservationId:op.subjectId);
    const owner=one(this.db,'SELECT reasons FROM owner_state WHERE owner_id=?',r.ownerId);
    if(!owner)return;
    const before=json<string[]>(owner,'reasons'),reasons=before.filter(reason=>reason!==`UNKNOWN_OPERATION:${op.id}`);
    if(before.length===reasons.length)return;
    run(this.db,'UPDATE owner_state SET reasons=?,spend_blocked=? WHERE owner_id=?',canonicalJson(reasons),reasons.length?1:0,r.ownerId);
    audit(this.db,r,'RECONCILE',0,serverNow(this.clock),'Positive correlated provider result resolves this operation ambiguity; other blocks retained');
  }
  private pending(op:Operation):void {
    if(this.closable(op))recordOperationPending(this.db,op.id,this.clock);
  }
  private capture(id:string,c:CaptureResource):void {
    assertTransaction(this.db);
    observeCaptureInTransaction(this.db,id,{captureId:c.id,orderId:c.supplementary_data.related_ids.order_id,currency:c.amount.currency_code,amount:c.amount.value,status:['REFUNDED','PARTIALLY_REFUNDED'].includes(c.status)?'COMPLETED':c.status as 'COMPLETED'|'PENDING'|'DECLINED',evidence:this.evidence(c)});
  }
  private captureResult(op:Operation,captures:readonly CaptureResource[]):void {
    const r=reservation(this.db,op.subjectId);
    // Only facts explained by THIS positive resource can close the operation.
    // An unrelated prior capture, foreign currency or quarantined contradiction cannot.
    const exact=captures.filter(c=>{
      if(c.amount.currency_code!=='USD' || c.supplementary_data.related_ids.order_id!==r.orderId)return false;
      let amount:number;try {amount=parseMinor(c.amount.value,'USD');}catch{return false;}
      if(amount<=0)return false;
      const fact=one(this.db,'SELECT * FROM provider_captures WHERE capture_id=?',c.id);
      if(fact)return ['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(c.status) && text(fact,'reservation_id')===r.id && text(fact,'order_id')===r.orderId && text(fact,'currency')==='USD' && int(fact,'amount_minor')===amount && int(fact,'completion_observed')===1;
      return c.status==='DECLINED' && r.state==='RELEASED' && r.capturedMinor===0 && !!one(this.db,"SELECT 1 FROM capture_status_facts WHERE capture_id=? AND reservation_id=? AND status='DECLINED'",c.id,r.id);
    });
    if(exact.some(c=>['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(c.status)))this.finish(op,'DONE');
    else if(exact.some(c=>c.status==='DECLINED'))this.finish(op,'FAILED_DEFINITIVE');
    else this.pending(op);
  }
  // One synchronous IMMEDIATE action covers correlation, all unique facts,
  // monetary/audit changes, eligible operation closure and its exact UNKNOWN reason.
  async apply(op:Operation,input:ProviderResource,closeOperation=true):Promise<void> {
    try {await withImmediate(this.db,()=>{
      this.failures.assertWritable();
      const stored=operation(this.db,op.id);
      if(stored.kind!==op.kind || stored.subjectId!==op.subjectId || stored.requestId!==op.requestId || stored.bodyHash!==op.bodyHash)throw new Error('OPERATION_SUBJECT_MISMATCH');
      if(op.kind==='REFUND_CREATE') {
        const f=refund(this.db,op.subjectId),r=reservation(this.db,f.reservationId),v=validateResource('refund',input,this.provider.merchantId) as RefundResource;
        if(v.supplementary_data.related_ids.capture_id!==f.captureId || f.providerRefundId!==null && f.providerRefundId!==v.id) {
          observation(this.db,this.evidence(v));anomaly(this.db,r,'AMOUNT_CONTRADICTION',serverNow(this.clock));return;
        }
        observeRefundInTransaction(this.db,{refundId:v.id,captureId:f.captureId,currency:v.amount.currency_code,amount:v.amount.value,status:v.status,evidence:this.evidence(v)},f.id);
        const after=refund(this.db,f.id);
        let exact=false;try {exact=v.amount.currency_code==='USD' && parseMinor(v.amount.value,'USD')===f.amount;}catch { /* reducer retained quarantine */ }
        if(!closeOperation || !exact || after.providerRefundId!==v.id)return;
        if(v.status==='COMPLETED' && after.completedApplied && this.closable(op)) {
          // Existing positive-fact helper and all of its guards stay unchanged.
          recordRefundOperationCompleted(this.db,op.id,op.ownerToken!,v.id,this.clock);
          this.finish(op,'DONE');
        } else if((v.status==='FAILED'||v.status==='CANCELLED') && after.state===v.status && !after.completedApplied)this.finish(op,'FAILED_DEFINITIVE');
        else this.pending(op);
        return;
      }
      const r=reservation(this.db,op.subjectId),v=validateResource('order',input,this.provider.merchantId) as OrderResource,u=v.purchase_units[0]!;
      let exact=false;try {exact=u.amount.currency_code==='USD' && parseMinor(u.amount.value,'USD')===r.amount;}catch { /* quarantine below */ }
      if(u.custom_id!==r.id || u.invoice_id!==r.id || !exact || r.orderId!==null && r.orderId!==v.id) {
        observation(this.db,this.evidence(v));anomaly(this.db,r,u.amount.currency_code!=='USD'?'CURRENCY_MISMATCH':'ORDER_FOR_UNKNOWN_RESERVATION',serverNow(this.clock));return;
      }
      const now=serverNow(this.clock),state=r.state==='CREATING'||r.state==='CREATE_UNKNOWN'?'ORDER_CREATED':r.state;
      if(r.orderId===null || r.state==='CREATING' || r.state==='CREATE_UNKNOWN') {
        saveReservation(this.db,{...r,orderId:v.id,state,updatedAt:now});
        observation(this.db,this.evidence(v));audit(this.db,r,'ORDER',0,now,`Correlated ${this.provider.mode} order`,this.provider.mode,{orderId:v.id});
      }
      const next=reservation(this.db,r.id);
      if(v.status==='APPROVED' && next.state==='ORDER_CREATED') {saveReservation(this.db,{...next,state:'APPROVED',updatedAt:now});audit(this.db,next,'APPROVE',0,now,this.provider.mode==='fixture'?'SIMULATED PAYPAL APPROVAL':'PayPal sandbox approval confirmed by GET',this.provider.mode,{orderId:v.id});}
      const captures=u.payments?.captures??[];
      for(const c of captures)this.capture(r.id,c);
      if(!closeOperation)return;
      if(op.kind==='ORDER_CREATE')this.finish(op,'DONE');
      else this.captureResult(op,captures);
    },{clock:this.clock});}catch(error){this.failures.observe(error);throw error;}
  }
  async applyCapture(id:string,input:CaptureResource):Promise<void> {
    try {await withImmediate(this.db,()=>{
      this.failures.assertWritable();
      const c=validateResource('capture',input,this.provider.merchantId) as CaptureResource;
      this.capture(id,c);
      const row=one(this.db,"SELECT id FROM operations WHERE kind='ORDER_CAPTURE' AND subject_id=?",id);
      if(row)this.captureResult(operation(this.db,text(row,'id')),[c]);
    },{clock:this.clock});}catch(error){this.failures.observe(error);throw error;}
  }
  // One admitted payment session/process; durable S1 CAS remains the cross-process gate.
  // OAuth is absent in fixture mode. No transport can be supplied from a route body.
  async dispatch(id:string,session:OwnerSession,parent:Deadline):Promise<'attempted'|'already_claimed'> {
    this.failures.assertWritable();
    if(this.sending) throw new Error('PAYMENT_SESSION_BUSY_503');
    this.sending=true;
    const scope=deadlineScope(parent.signal,Math.min(parent.monotonicEndsAt,session.deadlineMono,this.clock.monotonicNow()+LIMITS.post.sessionMs),this.clock);
    let claimed=false;
    try {
      assertDeadline(scope,this.clock);const initial=operation(this.db,id);
      if(initial.state!=='READY') return 'already_claimed';
      let approval:Readonly<{orderId:string;observedAt:number;status:'APPROVED';amountMinor:number;merchantId:string}>|undefined;
      let target:string|null=null;
      if(initial.kind==='ORDER_CAPTURE') {
        const r=reservation(this.db,initial.subjectId);target=resourceId(r.orderId);
        const preflight=deadlineScope(scope.signal,Math.min(scope.monotonicEndsAt,this.clock.monotonicNow()+LIMITS.get.attemptMs),this.clock);
        try {
          const v=validateResource('order',await this.provider.get('order',target,preflight),this.provider.merchantId) as OrderResource;
          await this.apply(initial,v,false);
          const u=v.purchase_units[0]!;
          if(v.status!=='APPROVED' || v.id!==target || u.custom_id!==r.id || u.invoice_id!==r.id || u.amount.currency_code!=='USD' || parseMinor(u.amount.value,'USD')!==r.amount) throw new Error('NOT_APPROVED_409');
          approval={orderId:target,observedAt:serverNow(this.clock),status:'APPROVED',amountMinor:r.amount,merchantId:this.provider.merchantId};
        } finally {preflight.close();}
      } else if(initial.kind==='REFUND_CREATE') target=refund(this.db,initial.subjectId).captureId;
      assertDeadline(scope,this.clock);
      this.failures.assertWritable();
      const permit=await claimOperation(this.db,id,{sessionDeadlineMono:scope.monotonicEndsAt,sessionExpiresAt:session.expiresAt,...(approval?{approval}:{})},{clock:this.clock,parentDeadlineMono:scope.monotonicEndsAt,wait:async ms=>{await delay(ms,undefined,{signal:scope.signal});this.failures.assertWritable();assertDeadline(scope,this.clock);}});
      if(!permit) return 'already_claimed';
      claimed=true;
      const wire=deadlineScope(scope.signal,Math.min(scope.monotonicEndsAt,this.clock.monotonicNow()+LIMITS.post.wireMs),this.clock);
      try {
        assertDeadline(wire,this.clock);
        this.failures.assertWritable();
        const op=consumeSendPermit(permit);
        // No await between permit consumption and the sole logical POST. The
        // adapter may replay once on 401 with the identical request ID/body.
        const result=await this.provider.post({kind:op.kind,resourceId:target,requestId:op.requestId,canonicalBody:op.canonicalBody},{...wire,onResourceId:async resource=>{
          await withImmediate(this.db,()=>{
            const current=operation(this.db,op.id);
            if(current.ownerToken!==op.ownerToken || current.state!=='SENDING')throw new Error('POST_ID_FENCE_LOST');
            if(op.kind==='REFUND_CREATE') {
              const f=refund(this.db,op.subjectId);
              if(f.providerRefundId && f.providerRefundId!==resource)throw new Error('POST_ID_CONFLICT');
              run(this.db,'UPDATE refunds SET provider_refund_id=? WHERE id=?',resource,f.id);
            } else {
              const r=reservation(this.db,op.subjectId);
              if(r.orderId && r.orderId!==resource)throw new Error('POST_ID_CONFLICT');
              // Recovery locator only; no approval, amount or ownership is inferred.
              saveReservation(this.db,{...r,orderId:resource,updatedAt:serverNow(this.clock)});
            }
          },{clock:this.clock});
        }});
        await this.apply(op,result);
      } finally {wire.close();}
      return 'attempted';
    } catch(error) {
      this.failures.observe(error);this.failures.assertWritable();
      if(claimed) {
        await withImmediate(this.db,()=>{
          this.failures.assertWritable();
          const diagnostic=error instanceof Error && error.message==='PAYPAL_REFUND_CORRELATION_MISMATCH'?'PAYPAL_REFUND_CORRELATION_MISMATCH':undefined;
          markUnknown(this.db,id,serverNow(this.clock),diagnostic);
          if(error instanceof Error && error.message==='PAYPAL_ORDER_MERCHANT_UNSUPPORTED')run(this.db,'UPDATE operations SET last_error=? WHERE id=?','PAYPAL_ORDER_MERCHANT_UNSUPPORTED: recoverable; capture blocked until authenticated merchant evidence is available',id);
        },{clock:this.clock});
        return 'attempted';
      }
      throw error;
    } finally {scope.close();this.sending=false;}
  }
  async retainUncorrelated(ownerId:string,input:ProviderResource):Promise<void> {
    this.failures.assertWritable();
    try {await withImmediate(this.db,()=>{this.failures.assertWritable();observation(this.db,this.evidence(input));blockOwner(this.db,ownerId,'ORDER_FOR_UNKNOWN_RESERVATION');},{clock:this.clock});}catch(error){this.failures.observe(error);throw error;}
  }
}

export { FixtureDispatcher as PayPalDispatcher };
