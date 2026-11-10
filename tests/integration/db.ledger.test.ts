// SQLite ledger integration, including in-memory transactions.
import { afterEach,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb,immediate } from '../../src/server/db/db.ts';
import type { Db } from '../../src/server/db/db.ts';
import { all,budget,one,reservation,run,saveReservation } from '../../src/server/db/repo.ts';
import { LedgerService } from '../../src/domain/ledger/service.ts';
import { assertLedgerInvariants } from '../../src/domain/ledger/invariants.ts';
import { observeCapture,observeRefund,acknowledge } from '../../src/domain/ledger/facts.ts';
import { safeDefaults } from '../../src/domain/policy/policy.ts';
import { categoryMap,enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { claimOperation,consumeSendPermit,recoverExpiredSending,createOperation,claimAutomaticGetAttempt,recordOperationPending } from '../../src/server/operations.ts';
import { localEffect,pruneResponses,claimLease,finishLease } from '../../src/server/idempotency.ts';
import type { RefundRestoration } from '../../src/shared/types.ts';
import { TestClock,fixedClock } from '../helpers/clock.ts';
const now=Date.parse('2026-10-19T01:00:00Z');
const ctx=(at=now)=>({ownerId:'owner',key:randomUUID(),session:{expiresAt:at+43200000,deadlineMono:60000}});
const cart={proposalId:'a2',mandateId:'m',lines:[{sku:'COF-001',qty:2},{sku:'PRT-004',qty:1}],source:{kind:'owner' as const}};
const opened:Db[]=[];afterEach(()=>{for(const db of opened.splice(0))db.close();});
async function setup(restoration:RefundRestoration='never_restore') {
  const db=openDb(':memory:');opened.push(db);const clock=new TestClock(now);const service=new LedgerService(db,enforcementCatalogue,categoryMap,{clock}, 'demo-merchant');
  const draft={...safeDefaults('owner','m',now),refundRestoration:restoration};
  const signed=JSON.parse((await service.sign(ctx(),draft,{confirm:true,expectedCurrentHash:null,explicitlyAllowedSensitive:[]})).body).policy as {contentHash:string};
  const response=await service.reserve(ctx(),cart,signed.contentHash,true);const id=(JSON.parse(response.body) as {reservation:{id:string}}).reservation.id;
  immediate(db,()=>{const r=reservation(db,id);saveReservation(db,{...r,orderId:'ORDER-1',state:'APPROVED'});});
  return {db,service,id,hash:signed.contentHash,clock};
}
const evidence=(id:string,at=now)=>({resourceId:id,payloadHash:'a'.repeat(64),boundedRedactedJson:'{}',source:'fixture' as const,observedAt:at});
async function captured(restoration:RefundRestoration='never_restore') {const s=await setup(restoration);await observeCapture(s.db,s.id,{captureId:'CAP-1',orderId:'ORDER-1',currency:'USD',amount:'39.99',status:'COMPLETED',evidence:evidence('CAP-1')});return s;}
describe('S1 atomic DB gates F1/F2/F6/F12/F19/F20 DRAFT',()=>{
  it('reserves 3999 atomically and replays exact response after policy change/tombstone',async()=>{
    const s=await setup(); const c=ctx();let effects=0;
    const effect=()=>{effects++;return {status:202,body:{operationId:'stable'},effectId:'stable'};};
    const a=immediate(s.db,()=>localEffect(s.db,'scope',c.key,{expectedPolicyHash:s.hash},now,effect));
    const b=immediate(s.db,()=>localEffect(s.db,'scope',c.key,{expectedPolicyHash:s.hash},now+1,effect));
    expect(a).toEqual(b);expect(effects).toBe(1);
    expect(()=>immediate(s.db,()=>localEffect(s.db,'scope',c.key,{expectedPolicyHash:'different'},now,effect))).toThrow('KEY_REUSE');
    immediate(s.db,()=>pruneResponses(s.db,now+7*86400000));
    expect(()=>immediate(s.db,()=>localEffect(s.db,'scope',c.key,{expectedPolicyHash:s.hash},now+7*86400000,effect))).toThrow('EXPIRED');expect(effects).toBe(1);assertLedgerInvariants(s.db);
  });
  it('fences an expired compiler lease holder',async()=>{
    const s=await setup(),key=randomUUID();
    const a=immediate(s.db,()=>claimLease(s.db,'compile',key,{text:'x'},fixedClock(now)));
    const b=immediate(s.db,()=>claimLease(s.db,'compile',key,{text:'x'},fixedClock(now+65001)));
    expect(()=>immediate(s.db,()=>finishLease(s.db,'compile',key,a,{},fixedClock(now+65002)))).toThrow('STALE');
    immediate(s.db,()=>finishLease(s.db,'compile',key,b,{ok:true},fixedClock(now+65002)));
  });
  it.each(['never_restore','restore_on_completed_refund'] as const)('CAS updates both refund counters once: %s',async restoration=>{
    const s=await captured(restoration);const response=await s.service.requestRefund(ctx(),'CAP-1',1000);
    const {refundId}=JSON.parse(response.body) as {refundId:string};
    const obs={refundId:'REF-1',captureId:'CAP-1',currency:'USD',amount:'10.00',status:'COMPLETED' as const,evidence:evidence('REF-1')};
    await observeRefund(s.db,obs,refundId);await observeRefund(s.db,obs,refundId);
    const b=budget(s.db,'owner','2026-W43@Asia/Singapore');expect(b.refundedCompletedMinor).toBe(1000);expect(b.restoredMinor).toBe(restoration==='never_restore'?0:1000);
    expect(all(s.db,"SELECT * FROM ledger_rows WHERE kind='REFUND_DONE'")).toHaveLength(1);assertLedgerInvariants(s.db);
  });
  it('retains pending/unknown refund headroom after acknowledgement',async()=>{
    const s=await captured();const response=await s.service.requestRefund(ctx(),'CAP-1',1000);const {refundId}=JSON.parse(response.body) as {refundId:string};
    immediate(s.db,()=>run(s.db,"UPDATE refunds SET state='REFUND_UNKNOWN' WHERE id=?",refundId));
    await acknowledge(s.db,s.id,now);await expect(s.service.requestRefund(ctx(),'CAP-1',100)).rejects.toThrow('REFUND_ACTIVE');
    expect(budget(s.db,'owner','2026-W43@Asia/Singapore').refundedCompletedMinor).toBe(0);assertLedgerInvariants(s.db);
  });
  it('reclassifies external completion to local once, retaining the owner anomaly block',async()=>{
    const s=await captured('restore_on_completed_refund');const response=await s.service.requestRefund(ctx(),'CAP-1',1000);const {refundId}=JSON.parse(response.body) as {refundId:string};
    const obs={refundId:'REF-1',captureId:'CAP-1',currency:'USD',amount:'10.00',status:'COMPLETED' as const,evidence:evidence('REF-1')};
    await observeRefund(s.db,obs,null);await observeRefund(s.db,obs,refundId);await observeRefund(s.db,obs,refundId);
    const b=budget(s.db,'owner','2026-W43@Asia/Singapore');expect(b.externalRefundedMinor).toBe(0);expect(b.refundedCompletedMinor).toBe(1000);expect(b.restoredMinor).toBe(1000);expect(b.spendBlocked).toBe(true);assertLedgerInvariants(s.db);
  });
  it('applies FAILED→COMPLETED contradiction while a newer commitment remains',async()=>{
    const s=await captured();const a=JSON.parse((await s.service.requestRefund(ctx(),'CAP-1',3000)).body) as {refundId:string};
    const obs={refundId:'REF-1',captureId:'CAP-1',currency:'USD',amount:'30.00',status:'FAILED' as const,evidence:evidence('REF-1')};
    await observeRefund(s.db,obs,a.refundId);const b=JSON.parse((await s.service.requestRefund(ctx(),'CAP-1',3000)).body) as {refundId:string};
    await observeRefund(s.db,{...obs,status:'COMPLETED'},a.refundId);
    expect(one(s.db,'SELECT state FROM refunds WHERE id=?',b.refundId)?.['state']).toBe('REQUESTED');expect(budget(s.db,'owner','2026-W43@Asia/Singapore').spendBlocked).toBe(true);assertLedgerInvariants(s.db);
  });
  it('retains late and extra captures after release, reversal and foreign-currency evidence',async()=>{
    const s=await setup();await s.service.cancel(ctx(),s.id);
    const obs={captureId:'CAP-1',orderId:'ORDER-1',currency:'USD',amount:'90.00',status:'COMPLETED' as const,evidence:evidence('CAP-1')};
    await observeCapture(s.db,s.id,obs);await observeCapture(s.db,s.id,obs);await observeCapture(s.db,s.id,{...obs,captureId:'CAP-2',amount:'10.00'});await observeCapture(s.db,s.id,{...obs,status:'REVERSED'});await observeCapture(s.db,s.id,{...obs,captureId:'CAP-3',currency:'EUR'});
    const b=budget(s.db,'owner','2026-W43@Asia/Singapore');expect(b.capturedMinor).toBe(10000);expect(b.reservedMinor).toBe(0);expect(b.availableMinor).toBe(-2000);expect(b.spendBlocked).toBe(true);expect(all(s.db,'SELECT * FROM provider_observations')).toHaveLength(5);assertLedgerInvariants(s.db);
  });
  it('same-period lower rejection rolls back releases, status and audit; raises retain consumed usage',async()=>{
    const s=await captured('restore_on_completed_refund');
    const held=JSON.parse((await s.service.reserve(ctx(),cart,s.hash,true)).body) as {reservation:{id:string}};
    const before=all(s.db,'SELECT * FROM ledger_rows');
    const draft={...safeDefaults('owner','m',now),allowanceMinor:3000,perOrderMaxMinor:3000,perLineMaxMinor:3000};
    await expect(s.service.sign(ctx(),draft,{confirm:true,expectedCurrentHash:s.hash,explicitlyAllowedSensitive:[]})).rejects.toThrow('ALLOWANCE_BELOW_USAGE');
    expect(reservation(s.db,held.reservation.id).holdMinor).toBe(3999);expect(all(s.db,'SELECT * FROM ledger_rows')).toEqual(before);
    await s.service.sign(ctx(),{...draft,allowanceMinor:10000,perOrderMaxMinor:8000},{confirm:true,expectedCurrentHash:s.hash,explicitlyAllowedSensitive:[]});
    expect(budget(s.db,'owner','2026-W43@Asia/Singapore').availableMinor).toBe(6001);expect(all(s.db,'SELECT * FROM budget_buckets')).toHaveLength(1);assertLedgerInvariants(s.db);
  });
  it('independent DB guard rejects a spend increase without the service guard',async()=>{
    const s=await setup();expect(()=>immediate(s.db,()=>run(s.db,'UPDATE budget_buckets SET reserved=reserved+6000 WHERE owner_id=? AND period_key=?','owner','2026-W43@Asia/Singapore'))).toThrow('BUDGET_SPEND_GUARD');assertLedgerInvariants(s.db);
  });
  describe('sensitivity',()=>{it('invariant catches removed DB and service guards on same materialized ledger',async()=>{
    const s=await setup();s.db.exec('DROP TRIGGER bucket_update_guard;');
    immediate(s.db,()=>run(s.db,'UPDATE budget_buckets SET reserved=reserved+6000 WHERE owner_id=? AND period_key=?','owner','2026-W43@Asia/Singapore'));
    expect(()=>assertLedgerInvariants(s.db)).toThrow();
  });});
});
describe('F3/F10/F18 in-process operation primitives DRAFT (multiprocess remains separate)',()=>{
  it('original plus two handlers receive one ephemeral one-use permit; recovery cannot reclaim POST',async()=>{
    const s=await setup();const op=immediate(s.db,()=>createOperation(s.db,'ORDER_CAPTURE',s.id,{},now,now+300000));
    const input={sessionDeadlineMono:60000,sessionExpiresAt:now+60000,approval:{orderId:'ORDER-1',observedAt:now,status:'APPROVED' as const,amountMinor:3999,merchantId:'demo-merchant' as const}};
    const winners=(await Promise.all([claimOperation(s.db,op.id,input,{clock:s.clock}),claimOperation(s.db,op.id,input,{clock:s.clock}),claimOperation(s.db,op.id,input,{clock:s.clock})])).filter(x=>x!==null);
    expect(winners).toHaveLength(1);const permit=winners[0]!;
    let outboundCalls=0;const fakeSend=()=>{outboundCalls++;}; // counter BEFORE provider dedupe (none here)
    consumeSendPermit(permit);fakeSend();expect(()=>consumeSendPermit(permit)).toThrow();
    immediate(s.db,()=>recoverExpiredSending(s.db,fixedClock(now+30001)));
    expect(await claimOperation(s.db,op.id,input,{clock:fixedClock(now+30001)})).toBeNull();expect(outboundCalls).toBe(1);
    expect(reservation(s.db,s.id).holdMinor).toBe(3999);assertLedgerInvariants(s.db);
  });
  it('revoke-first prevents claims; claim-first holds survive revoke',async()=>{
    const s=await setup();const op=immediate(s.db,()=>createOperation(s.db,'ORDER_CAPTURE',s.id,{},now,now+300000));
    const input={sessionDeadlineMono:60000,sessionExpiresAt:now+60000,approval:{orderId:'ORDER-1',observedAt:now,status:'APPROVED' as const,amountMinor:3999,merchantId:'demo-merchant' as const}};
    const permit=await claimOperation(s.db,op.id,input,{clock:s.clock});expect(permit).not.toBeNull();await s.service.revoke(ctx(),'m');
    expect(reservation(s.db,s.id).holdMinor).toBe(3999);expect(()=>consumeSendPermit(permit!)).not.toThrow();assertLedgerInvariants(s.db);
    const t=await setup();const op2=immediate(t.db,()=>createOperation(t.db,'ORDER_CAPTURE',t.id,{},now,now+300000));await t.service.revoke(ctx(),'m');expect(await claimOperation(t.db,op2.id,input,{clock:t.clock})).toBeNull();expect(reservation(t.db,t.id).holdMinor).toBe(0);
  });
  it('24 durable GET attempts/horizon do not release hold or reset send claim',async()=>{
    const s=await setup();const op=immediate(s.db,()=>createOperation(s.db,'ORDER_CAPTURE',s.id,{},now,now+300000));
    await claimOperation(s.db,op.id,{sessionDeadlineMono:60000,sessionExpiresAt:now+60000,approval:{orderId:'ORDER-1',observedAt:now,status:'APPROVED',amountMinor:3999,merchantId:'demo-merchant'}},{clock:s.clock});
    immediate(s.db,()=>recoverExpiredSending(s.db,fixedClock(now+30001)));
    for(let attempt=1;attempt<=24;attempt++)expect(immediate(s.db,()=>claimAutomaticGetAttempt(s.db,op.id,'CAP-1',fixedClock(now+attempt*300000)))).toBe(true);
    expect(immediate(s.db,()=>claimAutomaticGetAttempt(s.db,op.id,'CAP-1',fixedClock(now+25*300000)))).toBe(false);
    expect(one(s.db,'SELECT attempt,state,get_attempts FROM operations WHERE id=?',op.id)).toMatchObject({attempt:1,state:'MANUAL',get_attempts:24});expect(reservation(s.db,s.id).holdMinor).toBe(3999);
  });
});
it('S2 pending refund mapping retains finite GET work without DONE or horizon reset',async()=>{
  const s=await captured();const response=JSON.parse((await s.service.requestRefund(ctx(),'CAP-1',1000)).body) as {operationId:string;refundId:string};
  await claimOperation(s.db,response.operationId,{sessionDeadlineMono:60000,sessionExpiresAt:now+60000},{clock:s.clock});
  const before=one(s.db,'SELECT horizon_until FROM operations WHERE id=?',response.operationId)?.['horizon_until'];
  // No transport is called; this represents a correlated authenticated PENDING response.
  await observeRefund(s.db,{refundId:'REF-PENDING',captureId:'CAP-1',currency:'USD',amount:'10.00',status:'PENDING',evidence:evidence('REF-PENDING')},response.refundId);
  immediate(s.db,()=>recordOperationPending(s.db,response.operationId,s.clock));s.clock.advance(60000);
  expect(immediate(s.db,()=>claimAutomaticGetAttempt(s.db,response.operationId,'REF-PENDING',s.clock))).toBe(true);
  expect(one(s.db,'SELECT state,horizon_until FROM operations WHERE id=?',response.operationId)).toMatchObject({state:'UNKNOWN',horizon_until:before});
});
