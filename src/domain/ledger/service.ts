import { randomUUID } from 'node:crypto';
import type { BudgetSnapshot, CartProposal, CategoryMap, EnforcementCatalogue, MandatePolicy, OperationKind, OwnerReview, Reservation } from '../../shared/types.ts';
import { canonicalJson } from '../../shared/canonical.ts';
import { LIMITS } from '../../shared/limits.ts';
import { withImmediate } from '../../server/db/db.ts';
import { systemClock,serverNow } from '../../shared/clock.ts';
import type { TransactionTiming } from '../../server/db/db.ts';
import type { Db } from '../../server/db/db.ts';
import { activePolicy, all, audit, budget, captureClaimed, ensureBucket, ensureOwner, int, latestPolicy, one, reservation, run, saveReservation, text } from '../../server/db/repo.ts';
import { localEffect,idempotencyScope } from '../../server/idempotency.ts';
import { createOperation } from '../../server/operations.ts';
import { evaluateCart } from '../engine/engine.ts';
import { signReviewedDraft } from '../policy/policy.ts';
import { addMinor, assertMinor, formatMinor } from '../money.ts';
import { weeklyPeriod } from './period.ts';
import { reduceRelease, refundHeadroom } from './state.ts';
export type CommandContext = Readonly<{ ownerId:string;key:string;session:Readonly<{expiresAt:number;deadlineMono:number}> }>;
export class LedgerService {
  readonly db:Db;
  readonly prices:EnforcementCatalogue;
  readonly categories:CategoryMap;
  readonly timing:TransactionTiming;
  readonly merchantId:string;
  constructor(db:Db, prices:EnforcementCatalogue, categories:CategoryMap,timing:TransactionTiming, merchantId:string) {
    this.db=db;this.merchantId=merchantId;
    this.prices=prices;
    this.categories=categories;
    this.timing=timing;
  }
  private transact<T>(ctx:CommandContext|undefined,action:(now:number)=>T):Promise<T> {
    const clock=this.timing.clock??systemClock;
    const parentDeadlineMono=Math.min(this.timing.parentDeadlineMono??Infinity,ctx?.session.deadlineMono??Infinity,clock.monotonicNow()+LIMITS.mutationMs);
    return withImmediate(this.db,()=>{
      const now=serverNow(clock);
      if(ctx && (!Number.isSafeInteger(ctx.session.expiresAt) || !Number.isFinite(ctx.session.deadlineMono) || now>=ctx.session.expiresAt || clock.monotonicNow()>=ctx.session.deadlineMono))throw new Error('SESSION_EXPIRED');
      return action(now);
    },{...this.timing,clock,parentDeadlineMono});
  }
  private capacity():void { if(int(one(this.db,'SELECT COUNT(*) AS n FROM ledger_rows')!,'n')>=LIMITS.ledgerRows) throw new Error('LEDGER_CAP_503'); }
  private current(ownerId:string,now:number):MandatePolicy {
    const p=activePolicy(this.db,ownerId); if(!p || !Number.isFinite(Date.parse(p.expiresAt)) || now>=Date.parse(p.expiresAt)) throw new Error('MANDATE_NOT_ACTIVE'); return p;
  }
  private release(r:Reservation,now:number):boolean {
    const next=reduceRelease(r,captureClaimed(this.db,r.id),now);
    if(next===r || r.holdMinor===0) return false;
    run(this.db,'UPDATE budget_buckets SET reserved=reserved-? WHERE owner_id=? AND period_key=?',r.holdMinor,r.ownerId,r.periodKey);
    saveReservation(this.db,next);
    run(this.db,"UPDATE operations SET state='FAILED_DEFINITIVE',last_error='cancelled before claim',updated_at=? WHERE subject_id=? AND kind IN('ORDER_CREATE','ORDER_CAPTURE') AND state='READY' AND attempt=0",now,r.id);
    audit(this.db,r,'RELEASE',r.holdMinor,now,'Unclaimed hold released; claimed captures retain holds'); return true;
  }
  private releaseOwnerUnclaimed(ownerId:string,now:number):number {
    let released=0;
    for(const row of all(this.db,'SELECT id FROM reservations WHERE owner_id=? AND hold_minor>0',ownerId)) if(this.release(reservation(this.db,text(row,'id')),now)) released++;
    return released;
  }
  sign(ctx:CommandContext,draft:unknown,review:OwnerReview) {
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST','mandates/sign','owner'),ctx.key,{draft,review},now,()=>{
      this.capacity(); ensureOwner(this.db,ctx.ownerId);
      const prior=latestPolicy(this.db,ctx.ownerId), active=activePolicy(this.db,ctx.ownerId);
      const input=draft as MandatePolicy;
      if(input.ownerId!==ctx.ownerId) throw new Error('OWNER_MISMATCH');
      if(input.merchantId!==this.merchantId)throw new Error('REQUEST_SCHEMA_422');
      const highest=one(this.db,'SELECT COALESCE(MAX(version),0) AS n FROM mandates WHERE id=?',input.mandateId)!;
      if(one(this.db,'SELECT 1 FROM mandates WHERE id=? AND owner_id!=?',input.mandateId,ctx.ownerId)) throw new Error('MANDATE_OWNER_MISMATCH');
      const signed=signReviewedDraft(draft,review,this.categories,now,prior?.contentHash??null,int(highest,'n')+1);
      const released=this.releaseOwnerUnclaimed(ctx.ownerId,now);
      const key=weeklyPeriod(now).periodKey; ensureBucket(this.db,ctx.ownerId,key,signed.allowanceMinor);
      const b=budget(this.db,ctx.ownerId,key); const usage=addMinor(b.reservedMinor,b.capturedMinor,-b.restoredMinor);
      if(signed.allowanceMinor<usage) throw new Error('ALLOWANCE_BELOW_USAGE_409'); // rolls back releases/audit too
      if(run(this.db,'UPDATE budget_buckets SET allowance=? WHERE owner_id=? AND period_key=? AND ? >= reserved+captured-restored',signed.allowanceMinor,ctx.ownerId,key,signed.allowanceMinor)!==1) throw new Error('ALLOWANCE_BELOW_USAGE_409');
      if(active) run(this.db,"UPDATE mandates SET status='SUPERSEDED' WHERE owner_id=? AND status='ACTIVE'",ctx.ownerId);
      run(this.db,'INSERT INTO mandates(id,owner_id,version,status,policy_json,content_hash,signed_at) VALUES(?,?,?,?,?,?,?)',signed.mandateId,ctx.ownerId,signed.version,'ACTIVE',canonicalJson(signed),signed.contentHash,signed.signedAt);
      audit(this.db,{ownerId:ctx.ownerId,mandateId:signed.mandateId,policyVersion:signed.version,periodKey:key},'SIGN',0,now,'Shared owner-period allowance updated; prior usage retained');
      return {status:200,body:{policy:signed,released,budget:budget(this.db,ctx.ownerId,key)},effectId:`${signed.mandateId}:${signed.version}`};
    }));
  }
  revoke(ctx:CommandContext,mandateId:string) {
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST','mandates/revoke',mandateId),ctx.key,{},now,()=>{
      const p=this.current(ctx.ownerId,now); if(p.mandateId!==mandateId) throw new Error('NOT_ACTIVE');
      const count=(kind:OperationKind)=>int(one(this.db,'SELECT COUNT(*) AS n FROM operations o JOIN reservations r ON r.id=o.subject_id WHERE r.owner_id=? AND r.mandate_id=? AND r.policy_version=? AND o.kind=? AND o.attempt=1',ctx.ownerId,p.mandateId,p.version,kind)!,'n');
      const captureClaimedBeforeRevoke=count('ORDER_CAPTURE'),createClaimedBeforeRevoke=count('ORDER_CREATE');
      run(this.db,"UPDATE mandates SET status='REVOKED',revoked_at=? WHERE id=? AND version=?",now,p.mandateId,p.version);
      const released=this.releaseOwnerUnclaimed(ctx.ownerId,now),key=weeklyPeriod(now).periodKey;
      ensureBucket(this.db,ctx.ownerId,key,p.allowanceMinor);
      audit(this.db,{ownerId:ctx.ownerId,mandateId:p.mandateId,policyVersion:p.version,periodKey:key},'REVOKE',0,now,`${captureClaimedBeforeRevoke} earlier capture claims may still complete`);
      return {status:200,body:{policy:{...p,status:'REVOKED'},released,captureClaimedBeforeRevoke,createClaimedBeforeRevoke},effectId:`${p.mandateId}:${p.version}`};
    }));
  }
  reserve(ctx:CommandContext,proposal:CartProposal,expectedPolicyHash:string,stepUpConfirmed=false) {
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST','carts/reserve','owner'),ctx.key,{proposal,expectedPolicyHash,stepUpConfirmed},now,()=>{
      this.capacity(); const p=this.current(ctx.ownerId,now);
      if(p.contentHash!==expectedPolicyHash) throw new Error('STALE_POLICY_409');
      const periodKey=weeklyPeriod(now).periodKey; ensureBucket(this.db,ctx.ownerId,periodKey,p.allowanceMinor);
      const b=budget(this.db,ctx.ownerId,periodKey),verdict=evaluateCart(p,this.prices,this.categories,proposal,b,now,stepUpConfirmed,this.merchantId);
      if(!verdict.ok || verdict.orderTotalMinor===null) {
        audit(this.db,{ownerId:ctx.ownerId,mandateId:p.mandateId,policyVersion:p.version,periodKey},'REJECT',0,now,'Deterministic policy rejection',undefined,{},verdict.ruleIds);
        return {status:verdict.ruleIds.length===1 && verdict.ruleIds[0]==='R12_STEP_UP_REQUIRED'?428:verdict.ruleIds.includes('R11_INSUFFICIENT_ALLOWANCE')?409:422,body:{verdict,budget:b},effectId:null};
      }
      const amount=verdict.orderTotalMinor;
      if(run(this.db,'UPDATE budget_buckets SET reserved=reserved+? WHERE owner_id=? AND period_key=? AND allowance-reserved-captured+restored>=? AND NOT EXISTS(SELECT 1 FROM owner_state WHERE owner_id=? AND spend_blocked=1)',amount,ctx.ownerId,periodKey,amount,ctx.ownerId)!==1) throw new Error('INSUFFICIENT_ALLOWANCE_409');
      const id=randomUUID();
      run(this.db,"INSERT INTO reservations(id,owner_id,mandate_id,policy_version,policy_hash,period_key,restoration,state,amount,hold_minor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'HELD',?,?,?,?)",id,ctx.ownerId,p.mandateId,p.version,p.contentHash,periodKey,p.refundRestoration,amount,amount,now,now);
      for(const line of verdict.lines) run(this.db,'INSERT INTO reservation_lines(reservation_id,sku,category_id,qty,unit_minor,line_minor) VALUES(?,?,?,?,?,?)',id,line.sku,line.categoryId!,line.qty,this.prices[line.sku]!.unitPriceMinor,line.lineTotalMinor!);
      const r=reservation(this.db,id); audit(this.db,r,'RESERVE',amount,now,'Trusted immutable lines; flat shipping 500');
      return {status:200,body:{reservation:r,verdict,budget:budget(this.db,ctx.ownerId,periodKey)},effectId:id};
    }));
  }
  cancel(ctx:CommandContext,id:string) {
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST','reservations/cancel',id),ctx.key,{},now,()=>{
      const r=reservation(this.db,id); if(r.ownerId!==ctx.ownerId || captureClaimed(this.db,id) || r.capturedMinor>0) throw new Error('BAD_STATE');
      this.release(r,now);return {status:200,body:{reservation:reservation(this.db,id)},effectId:id};
    }));
  }
  // Bounded sweep primitive; no timer/startup process is started by this class.
  expireUnclaimed():Promise<number> {
    return this.transact(undefined,now=>{
      let n=0;
      for(const row of all(this.db,'SELECT id FROM reservations WHERE hold_minor>0 ORDER BY created_at LIMIT 100')) {
        const r=reservation(this.db,text(row,'id')),p=activePolicy(this.db,r.ownerId);
        if(!p || p.mandateId!==r.mandateId || p.version!==r.policyVersion || now>=Date.parse(p.expiresAt) || now>=r.createdAt+LIMITS.reservationMs || weeklyPeriod(now).periodKey!==r.periodKey) if(this.release(r,now)) n++;
      }
      return n;
    });
  }
  preparePurchase(ctx:CommandContext,id:string,kind:'ORDER_CREATE'|'ORDER_CAPTURE',canonicalProviderBody:unknown) {
    // S2 must build/validate the transport-specific envelope before calling this primitive.
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST',kind,id),ctx.key,{canonicalProviderBody},now,()=>{
      const r=reservation(this.db,id),p=this.current(ctx.ownerId,now);
      if(r.ownerId!==ctx.ownerId || p.contentHash!==r.policyHash || p.mandateId!==r.mandateId || p.version!==r.policyVersion || r.periodKey!==weeklyPeriod(now).periodKey || now<r.createdAt || now>=r.createdAt+LIMITS.reservationMs || r.holdMinor===0 || budget(this.db,r.ownerId,r.periodKey).spendBlocked) throw new Error('MANDATE_NOT_ACTIVE');
      if(kind==='ORDER_CREATE' && r.state!=='HELD' || kind==='ORDER_CAPTURE' && r.state!=='APPROVED') throw new Error('BAD_STATE');
      const op=createOperation(this.db,kind,id,canonicalProviderBody,now,Math.min(r.createdAt+LIMITS.reservationMs,Date.parse(p.expiresAt),weeklyPeriod(now).endsAt));
      return {status:202,body:{operationId:op.id},effectId:op.id};
    }));
  }
  requestRefund(ctx:CommandContext,captureId:string,amountMinor?:number) {
    return this.transact(ctx,now=>localEffect(this.db,idempotencyScope(ctx.ownerId,'POST','captures/refunds',captureId),ctx.key,amountMinor===undefined?{}:{amountMinor},now,()=>{
      const cap=one(this.db,'SELECT * FROM provider_captures WHERE capture_id=?',captureId); if(!cap) throw new Error('CAPTURE_NOT_FOUND');
      const r=reservation(this.db,text(cap,'reservation_id')); if(r.ownerId!==ctx.ownerId || r.anomalyReasons.length) throw new Error('CAPTURE_REFUND_BLOCKED');
      if(one(this.db,"SELECT 1 FROM refunds WHERE capture_id=? AND state IN('REQUESTED','SUBMITTING','PROVIDER_PENDING','REFUND_UNKNOWN')",captureId)) throw new Error('REFUND_ACTIVE');
      const completed=int(one(this.db,'SELECT COALESCE(SUM(amount_minor),0) AS n FROM provider_refund_facts WHERE capture_id=?',captureId)!,'n');
      const headroom=refundHeadroom(int(cap,'amount_minor'),completed,0,0),amount=amountMinor??headroom;
      assertMinor(amount,true); if(amount<=0 || amount>headroom) throw new Error('REFUND_EXCEEDS_REMAINING');
      const id=randomUUID();run(this.db,"INSERT INTO refunds(id,capture_id,reservation_id,amount,state,created_at,updated_at) VALUES(?,?,?,?,'REQUESTED',?,?)",id,captureId,r.id,amount,now,now);
      const op=createOperation(this.db,'REFUND_CREATE',id,{amount:{currency_code:'USD',value:formatMinor(amount,'USD')}},now,now+LIMITS.readyMs);
      audit(this.db,r,'REFUND_REQ',amount,now,'Headroom committed; no budget restoration');
      return {status:202,body:{operationId:op.id,refundId:id},effectId:op.id};
    }));
  }
}
export function snapshotAvailable(b:BudgetSnapshot):number { return addMinor(b.allowanceMinor,-b.reservedMinor,-b.capturedMinor,b.restoredMinor); }
