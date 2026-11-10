import { FailureLatch } from './request-control.ts';
import { randomUUID } from 'node:crypto';
import type { Db } from './db/db.ts';
import { withImmediate } from './db/db.ts';
import { all, blockOwner, int, one, operation, refund, reservation, run, text } from './db/repo.ts';
import { claimAutomaticGetAttempt, markUnknown } from './operations.ts';
import { FixtureDispatcher } from './dispatcher.ts';
import { serverNow, systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import { LIMITS } from '../shared/limits.ts';
import type { Deadline } from '../shared/io-contracts.ts';
import { assertDeadline, deadlineScope } from './session.ts';
import { resourceId, validateResource } from './paypal/provider.ts';
import type { CaptureResource, RefundResource, ResourceKind } from './paypal/provider.ts';

export type RecoveryResult=Readonly<{checked:number;changed:number;anomalies:number;deferred:number;cursor:string}>;
// Source-only callable runner. No constructor/import timer, listener or sweep.
export class FixtureRecovery {
  readonly db:Db;
  readonly dispatcher:FixtureDispatcher;
  readonly ownerId:string;
  readonly clock:ServerClock;
  state:'running'|'done'|'deadline_exceeded'='running';
  private active=false;
  readonly failures:FailureLatch;
  constructor(db:Db,dispatcher:FixtureDispatcher,ownerId:string,clock:ServerClock=systemClock,failures=new FailureLatch()) {this.db=db;this.dispatcher=dispatcher;this.ownerId=ownerId;this.clock=clock;this.failures=failures;}
  async enqueue(operationId:string):Promise<void> {
    this.failures.assertWritable();
    try {await withImmediate(this.db,()=>{
      this.failures.assertWritable();
      const op=operation(this.db,operationId),now=serverNow(this.clock);
      const existing=one(this.db,"SELECT 1 FROM reconcile_jobs WHERE subject_type='operation' AND subject_id=?",op.id);
      if(!existing && int(one(this.db,"SELECT COUNT(*) AS n FROM reconcile_jobs WHERE state IN('PENDING','ACTIVE')")!,'n')>=LIMITS.jobs) throw new Error('RECONCILE_QUEUE_FULL_503');
      run(this.db,"INSERT INTO reconcile_jobs(subject_type,subject_id,state,deadline,next_at) VALUES('operation',?,'PENDING',?,?) ON CONFLICT(subject_type,subject_id) DO UPDATE SET state=CASE WHEN reconcile_jobs.state='ACTIVE' THEN 'ACTIVE' ELSE 'PENDING' END",op.id,op.horizonUntil??now+LIMITS.autoGet.horizonMs,now);
    },{clock:this.clock});}catch(error){this.failures.observe(error);throw error;}
  }
  async run(parent:Deadline,kind:'startup'|'manual',reservationId?:string):Promise<RecoveryResult> {
    this.failures.assertWritable();assertDeadline(parent,this.clock);
    if(this.active) throw new Error('RECONCILE_RUNNING_409');
    this.active=true;const token=randomUUID();let owned=false,cursor='',checked=0,changed=0,deferred=0,gets=0,lastRenew=0;
    const scope=deadlineScope(parent.signal,Math.min(parent.monotonicEndsAt,this.clock.monotonicNow()+(kind==='startup'?LIMITS.recovery.startupMs:LIMITS.recovery.manualMs)),this.clock);
    const fenced=async<T>(action:()=>T):Promise<T>=>withImmediate(this.db,()=>{
      this.failures.assertWritable();assertDeadline(scope,this.clock);
      const now=serverNow(this.clock),lock=one(this.db,"SELECT * FROM maintenance_lock WHERE name='recovery'");
      if(!lock || text(lock,'owner_token')!==token || int(lock,'lease_until')<=now || lock['last_clock']!==null && now<int(lock,'last_clock')) throw new Error('MAINTENANCE_FENCE_LOST');
      if(now-lastRenew>=LIMITS.maintenance.renewalMs) {run(this.db,"UPDATE maintenance_lock SET lease_until=?,last_clock=? WHERE name='recovery' AND owner_token=?",now+LIMITS.maintenance.leaseMs,now,token);lastRenew=now;}
      return action();
    },{clock:this.clock,parentDeadlineMono:scope.monotonicEndsAt});
    try {
      await withImmediate(this.db,()=>{
        this.failures.assertWritable();assertDeadline(scope,this.clock);
        const now=serverNow(this.clock),prior=one(this.db,"SELECT * FROM maintenance_lock WHERE name='recovery'");
        if(prior && prior['last_clock']!==null && now<int(prior,'last_clock')) {throw new Error('RECOVERY_CLOCK_ROLLBACK');}
        if(prior && prior['lease_until']!==null && int(prior,'lease_until')>now) throw new Error('RECONCILE_RUNNING_409');
        if(kind==='manual') {
          const rate=one(this.db,'SELECT last_clock FROM maintenance_lock WHERE name=?',`manual:${this.ownerId}`);
          if(rate && rate['last_clock']!==null && now-int(rate,'last_clock')<LIMITS.recovery.manualIntervalMs) throw new Error('RECONCILE_RATE_429');
          run(this.db,'INSERT INTO maintenance_lock(name,last_clock) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_clock=excluded.last_clock',`manual:${this.ownerId}`,now);
        }
        cursor=reservationId?'':prior?text(prior,'cursor'):'';
        run(this.db,"INSERT INTO maintenance_lock(name,owner_token,lease_until,cursor,last_clock) VALUES('recovery',?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner_token=excluded.owner_token,lease_until=excluded.lease_until,last_clock=excluded.last_clock",token,now+LIMITS.maintenance.leaseMs,cursor,now);
        lastRenew=now;
      },{clock:this.clock,parentDeadlineMono:scope.monotonicEndsAt});owned=true;
      const rows=reservationId?all(this.db,"SELECT o.id FROM operations o LEFT JOIN refunds f ON o.kind='REFUND_CREATE' AND f.id=o.subject_id WHERE o.subject_id=? OR f.reservation_id=? ORDER BY o.id LIMIT 100",reservationId,reservationId):all(this.db,'SELECT id FROM operations WHERE id>? ORDER BY id LIMIT 100',cursor);
      for(const row of rows) {
        assertDeadline(scope,this.clock);const id=text(row,'id');let op=operation(this.db,id);
        const r=reservation(this.db,op.kind==='REFUND_CREATE'?refund(this.db,op.subjectId).reservationId:op.subjectId);
        if(r.ownerId!==this.ownerId) throw new Error('RECOVERY_OWNER_MISMATCH');
        checked++;
        if(op.state==='SENDING' && op.sendDeadline!==null && serverNow(this.clock)>=op.sendDeadline) {await fenced(()=>markUnknown(this.db,id,serverNow(this.clock)));op=operation(this.db,id);}
        const target=op.kind==='REFUND_CREATE'?refund(this.db,op.subjectId).providerRefundId:r.orderId;
        // Preserve lifecycle expiry even when there is no recoverable locator.
        // This transition admits no wire call and consumes no GET attempt.
        if(['UNKNOWN','SENDING'].includes(op.state) && (target===null || op.horizonUntil!==null && serverNow(this.clock)>=op.horizonUntil || op.getAttempts>=LIMITS.autoGet.attempts)) {
          await fenced(()=>claimAutomaticGetAttempt(this.db,id,target,this.clock));op=operation(this.db,id);
        }
        // MANUAL only allows explicit later bounded GET, never another POST.
        const eligible=gets<LIMITS.recovery.gets && target!==null && (kind==='manual'?['UNKNOWN','MANUAL','DONE'].includes(op.state):['UNKNOWN','SENDING'].includes(op.state) && (op.nextGetAt===null || serverNow(this.clock)>=op.nextGetAt));
        if(eligible && target && gets<LIMITS.recovery.gets) {
          await fenced(()=>{
            const now=serverNow(this.clock),job=one(this.db,"SELECT 1 FROM reconcile_jobs WHERE subject_type='operation' AND subject_id=?",id);
            if(!job && int(one(this.db,"SELECT COUNT(*) AS n FROM reconcile_jobs WHERE state IN('PENDING','ACTIVE')")!,'n')>=LIMITS.jobs) throw new Error('RECONCILE_QUEUE_FULL_503');
            run(this.db,"INSERT INTO reconcile_jobs(subject_type,subject_id,state,owner_token,lease_until,attempts,deadline,next_at) VALUES('operation',?,'ACTIVE',?,?,1,?,?) ON CONFLICT(subject_type,subject_id) DO UPDATE SET state='ACTIVE',owner_token=excluded.owner_token,lease_until=excluded.lease_until,attempts=reconcile_jobs.attempts+1",id,token,now+LIMITS.maintenance.leaseMs,op.horizonUntil??now+LIMITS.recovery.manualMs,now);
          });
          const getScope=deadlineScope(scope.signal,Math.min(scope.monotonicEndsAt,this.clock.monotonicNow()+LIMITS.get.attemptMs),this.clock);
          let success=false;
          try {
            let admitted=0;
            const beforeGet=async()=>{if(gets>=LIMITS.recovery.gets)throw new Error('GET_PASS_BUDGET');
              const ok=kind==='manual'?true:await fenced(()=>claimAutomaticGetAttempt(this.db,id,target,this.clock,admitted>0));
              if(!ok)throw new Error('GET_DURABLE_BUDGET');gets++;admitted++;
            };
            if(this.dispatcher.provider.mode==='fixture')await beforeGet();
            const result=await this.dispatcher.provider.get(op.kind==='REFUND_CREATE'?'refund':'order',target,{...getScope,beforeGet,getPurpose:kind==='manual'?'manual':'automatic'});
            assertDeadline(getScope,this.clock);await this.dispatcher.apply(op,result);success=true;if(operation(this.db,id).state!==op.state) changed++;
          } catch(error) {this.failures.observe(error);this.failures.assertWritable();deferred++;} finally {getScope.close();}
          await fenced(()=>{run(this.db,"UPDATE reconcile_jobs SET state=?,next_at=? WHERE subject_type='operation' AND subject_id=? AND owner_token=? AND lease_until>?",success && ['DONE','FAILED_DEFINITIVE'].includes(operation(this.db,id).state)?'COMPLETE':'PENDING',serverNow(this.clock)+LIMITS.autoGet.initialIntervalMs,id,token,serverNow(this.clock));});
        } else if(!['DONE','FAILED_DEFINITIVE'].includes(op.state)) deferred++;
        cursor=id;
        if(!reservationId) await fenced(()=>run(this.db,"UPDATE maintenance_lock SET cursor=? WHERE name='recovery' AND owner_token=?",cursor,token));
      }
      const more=!reservationId && !!one(this.db,'SELECT 1 FROM operations WHERE id>? LIMIT 1',cursor);
      // Verified fixture webhook jobs are hints only. Resolve only known owned
      // resource identities, using constructed provider GET arguments, never links.
      if(!reservationId && checked<LIMITS.recovery.scan) {
        const cursorRow=one(this.db,"SELECT cursor FROM maintenance_lock WHERE name='webhook-cursor'");
        let hintCursor=cursorRow?text(cursorRow,'cursor'):'';
        const hints=all(this.db,"SELECT * FROM reconcile_jobs WHERE subject_type IN('order','capture','refund') AND state IN('PENDING','ACTIVE') AND (subject_type||':'||subject_id)>? ORDER BY subject_type,subject_id LIMIT ?",hintCursor,LIMITS.recovery.scan-checked);
        for(const hint of hints) {
          assertDeadline(scope,this.clock);checked++;
          const type=text(hint,'subject_type') as ResourceKind,id=resourceId(text(hint,'subject_id')),now=serverNow(this.clock);
          const binding=type==='order'?one(this.db,'SELECT id FROM reservations WHERE owner_id=? AND order_id=?',this.ownerId,id):type==='capture'?one(this.db,'SELECT r.id FROM reservations r WHERE r.owner_id=? AND (EXISTS(SELECT 1 FROM provider_captures c WHERE c.reservation_id=r.id AND c.capture_id=?) OR EXISTS(SELECT 1 FROM capture_status_facts c WHERE c.reservation_id=r.id AND c.capture_id=?))',this.ownerId,id,id):one(this.db,'SELECT f.id,f.reservation_id FROM refunds f JOIN reservations r ON r.id=f.reservation_id WHERE r.owner_id=? AND f.provider_refund_id=?',this.ownerId,id);
          const opRow=binding?(type==='refund'?one(this.db,"SELECT id FROM operations WHERE kind='REFUND_CREATE' AND subject_id=?",text(binding,'id')):one(this.db,"SELECT id FROM operations WHERE subject_id=? AND kind IN('ORDER_CREATE','ORDER_CAPTURE') ORDER BY kind LIMIT 1",text(binding,'id'))):undefined;
          if(!binding) {await fenced(()=>blockOwner(this.db,this.ownerId,'UNLINKED_WEBHOOK_RESOURCE'));deferred++;}
          else if(gets>=LIMITS.recovery.gets || int(hint,'next_at')>now) deferred++;
          else if(now>=int(hint,'deadline') || int(hint,'attempts')>=LIMITS.autoGet.attempts) {await fenced(()=>run(this.db,"UPDATE reconcile_jobs SET state='MANUAL' WHERE subject_type=? AND subject_id=?",type,id));deferred++;}
          else {
            const boundOp=opRow?operation(this.db,text(opRow,'id')):null;
            if(boundOp && (boundOp.state==='MANUAL' || ['UNKNOWN','SENDING'].includes(boundOp.state) && boundOp.nextGetAt!==null && now<boundOp.nextGetAt)) {
              deferred++;hintCursor=`${type}:${id}`;
              await fenced(()=>run(this.db,"INSERT INTO maintenance_lock(name,cursor) VALUES('webhook-cursor',?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor",hintCursor));
              continue;
            }
            await fenced(()=>run(this.db,"UPDATE reconcile_jobs SET state='ACTIVE',owner_token=?,lease_until=?,attempts=attempts+1,next_at=? WHERE subject_type=? AND subject_id=?",token,now+LIMITS.maintenance.leaseMs,now+LIMITS.autoGet.initialIntervalMs,type,id));
            const getScope=deadlineScope(scope.signal,Math.min(scope.monotonicEndsAt,this.clock.monotonicNow()+LIMITS.get.attemptMs),this.clock);
            let success=false;
            try {
              assertDeadline(getScope,this.clock);
              let admitted=0;
              const beforeGet=async()=>{
                if(gets>=LIMITS.recovery.gets)throw new Error('GET_PASS_BUDGET');
                if(kind!=='manual' && boundOp && ['UNKNOWN','SENDING'].includes(operation(this.db,boundOp.id).state) && !await fenced(()=>claimAutomaticGetAttempt(this.db,boundOp.id,id,this.clock,admitted>0)))throw new Error('GET_DURABLE_BUDGET');
                gets++;admitted++;
              };
              if(this.dispatcher.provider.mode==='fixture')await beforeGet();
              const result=validateResource(type,await this.dispatcher.provider.get(type,id,{...getScope,beforeGet,getPurpose:kind==='manual'?'manual':'automatic'}),this.dispatcher.provider.merchantId);
              assertDeadline(getScope,this.clock);
              if(result.id!==id)throw new Error('WEBHOOK_GET_ID_MISMATCH');
              if(type==='capture') await this.dispatcher.applyCapture(text(binding,'id'),result as CaptureResource);
              else {
                if(!opRow)throw new Error('WEBHOOK_OPERATION_NOT_FOUND');
                if(type==='refund' && (result as RefundResource).supplementary_data.related_ids.capture_id!==refund(this.db,text(binding,'id')).captureId)throw new Error('WEBHOOK_REFUND_CORRELATION');
                await this.dispatcher.apply(operation(this.db,text(opRow,'id')),result);
              }
              success=true;changed++;
            } catch(error) {this.failures.observe(error);this.failures.assertWritable();deferred++;} finally {getScope.close();}
            await fenced(()=>{
              run(this.db,"UPDATE reconcile_jobs SET state=? WHERE subject_type=? AND subject_id=? AND owner_token=? AND lease_until>?",success?'COMPLETE':'PENDING',type,id,token,serverNow(this.clock));
              if(success)run(this.db,"UPDATE webhook_events SET state='COMPLETE' WHERE resource_type=? AND resource_id=? AND state='PENDING'",type,id);
            });
          }
          hintCursor=`${type}:${id}`;
          await fenced(()=>run(this.db,"INSERT INTO maintenance_lock(name,cursor) VALUES('webhook-cursor',?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor",hintCursor));
        }
        if(!one(this.db,"SELECT 1 FROM reconcile_jobs WHERE subject_type IN('order','capture','refund') AND state IN('PENDING','ACTIVE') AND (subject_type||':'||subject_id)>?",hintCursor)) await fenced(()=>run(this.db,"INSERT INTO maintenance_lock(name,cursor) VALUES('webhook-cursor','') ON CONFLICT(name) DO UPDATE SET cursor=''"));
      }
      await fenced(()=>{
        if(more) blockOwner(this.db,this.ownerId,'RECOVERY_SCAN_INCOMPLETE');
        if(!more && !reservationId) {
          run(this.db,"UPDATE maintenance_lock SET cursor='' WHERE name='recovery' AND owner_token=?",token);
          const owner=one(this.db,'SELECT reasons FROM owner_state WHERE owner_id=?',this.ownerId);
          if(owner) {const reasons=(JSON.parse(text(owner,'reasons')) as string[]).filter(x=>x!=='RECOVERY_SCAN_INCOMPLETE');run(this.db,'UPDATE owner_state SET reasons=?,spend_blocked=? WHERE owner_id=?',JSON.stringify(reasons),reasons.length?1:0,this.ownerId);}
        }
      });
      this.state=more?'deadline_exceeded':'done';
      return {checked,changed,anomalies:int(one(this.db,'SELECT COUNT(*) AS n FROM reservations WHERE owner_id=? AND anomaly_open=1',this.ownerId)!,'n'),deferred:deferred+(more?1:0),cursor};
    } catch(error) {
      this.state='deadline_exceeded';this.failures.observe(error);
      if(owned && !this.failures.reason)try {await withImmediate(this.db,()=>{this.failures.assertWritable();blockOwner(this.db,this.ownerId,'RECOVERY_SCAN_INCOMPLETE');},{clock:this.clock,parentDeadlineMono:scope.monotonicEndsAt});}catch(cleanupError){this.failures.observe(cleanupError);}
      throw error;
    } finally {
      try {
        if(owned && !this.failures.reason)await withImmediate(this.db,()=>run(this.db,"UPDATE maintenance_lock SET owner_token=NULL,lease_until=0 WHERE name='recovery' AND owner_token=?",token),{clock:this.clock,parentDeadlineMono:scope.monotonicEndsAt});
      } catch(error){this.failures.observe(error);throw error;}
      finally {scope.close();this.active=false;}
    }
  }
}

export { FixtureRecovery as PayPalRecovery };
