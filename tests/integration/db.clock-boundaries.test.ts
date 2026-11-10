// Drives retry using an injected SQLITE_BUSY at BEGIN,
// then an injected wait that advances server clocks.
import { afterEach,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb,immediate,withImmediate } from '../../src/server/db/db.ts';
import type { Db,TransactionTiming } from '../../src/server/db/db.ts';
import { LedgerService } from '../../src/domain/ledger/service.ts';
import { categoryMap,enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { safeDefaults } from '../../src/domain/policy/policy.ts';
import { budget,one,reservation,saveReservation } from '../../src/server/db/repo.ts';
import { claimOperation,consumeSendPermit,createOperation,recordOperationPending,claimAutomaticGetAttempt } from '../../src/server/operations.ts';
import { claimLease,finishLease } from '../../src/server/idempotency.ts';
import { TestClock } from '../helpers/clock.ts';
import { weeklyPeriod } from '../../src/domain/ledger/period.ts';
const base=Date.parse('2026-10-19T01:00:00Z');const opened:Db[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();});
function busyOnce(db:Db):Db {
  let first=true;
  return new Proxy(db,{get(target,key){
    if(key==='exec')return (sql:string)=>{if(sql==='BEGIN IMMEDIATE' && first){first=false;throw Object.assign(new Error('database is locked'),{errcode:5});}return target.exec(sql);};
    const value=Reflect.get(target,key,target) as unknown;return typeof value==='function'?value.bind(target):value;
  }});
}
const proposal={proposalId:'clock',mandateId:'m',lines:[{sku:'COF-001',qty:1}],source:{kind:'owner' as const}};
async function fixture(at=base,expiryMs=86400000) {
  const db=openDb(':memory:');opened.push(db);const clock=new TestClock(at);
  const ctx=()=>({ownerId:'owner',key:randomUUID(),session:{expiresAt:at+43200000,deadlineMono:60000}});
  const service=new LedgerService(db,enforcementCatalogue,categoryMap,{clock}, 'demo-merchant');
  const signed=JSON.parse((await service.sign(ctx(),{...safeDefaults('owner','m',at),expiresAt:new Date(at+expiryMs).toISOString()},{confirm:true,expectedCurrentHash:null,explicitlyAllowedSensitive:[]})).body) as {policy:{contentHash:string}};
  const reply=await service.reserve(ctx(),proposal,signed.policy.contentHash,true);const id=(JSON.parse(reply.body) as {reservation:{id:string}}).reservation.id;
  immediate(db,()=>saveReservation(db,{...reservation(db,id),orderId:'ORDER-1',state:'APPROVED'}));
  const op=immediate(db,()=>createOperation(db,'ORDER_CAPTURE',id,{},at,at+1800000));
  const input={sessionDeadlineMono:60000,sessionExpiresAt:at+60000,approval:{orderId:'ORDER-1',observedAt:at,status:'APPROVED' as const,amountMinor:1750,merchantId:'demo-merchant' as const}};
  const timing:TransactionTiming={clock,wait:async milliseconds=>clock.advance(milliseconds)};
  return {db,clock,ctx,id,op,input,timing,hash:signed.policy.contentHash};
}
it('re-samples policy expiry inside claim after BUSY backoff; no send claim',async()=>{
  const s=await fixture(base,25);
  await expect(claimOperation(busyOnce(s.db),s.op.id,s.input,s.timing)).rejects.toThrow('MANDATE_NOT_ACTIVE');
  expect(one(s.db,'SELECT attempt FROM operations WHERE id=?',s.op.id)?.['attempt']).toBe(0);
});
it('rechecks reservation TTL and period boundary after wait',async()=>{
  const s=await fixture();s.clock.advance(1800000-25);const input={...s.input,sessionExpiresAt:s.clock.wall+60000,sessionDeadlineMono:s.clock.mono+60000,approval:{...s.input.approval,observedAt:s.clock.wall}};
  await expect(claimOperation(busyOnce(s.db),s.op.id,input,s.timing)).rejects.toThrow();expect(one(s.db,'SELECT attempt FROM operations WHERE id=?',s.op.id)?.['attempt']).toBe(0);
  const t=await fixture(Date.parse('2026-10-18T15:59:59.990Z'));
  await expect(claimOperation(busyOnce(t.db),t.op.id,t.input,t.timing)).rejects.toThrow('MANDATE_NOT_ACTIVE');
});
it('rechecks fresh approval and session expiry rather than using admitted time',async()=>{
  const s=await fixture();const stale={...s.input,approval:{...s.input.approval,observedAt:base-4990}};
  await expect(claimOperation(busyOnce(s.db),s.op.id,stale,s.timing)).rejects.toThrow('FRESH_APPROVAL');
  const t=await fixture();await expect(claimOperation(busyOnce(t.db),t.op.id,{...t.input,sessionExpiresAt:base+25},t.timing)).rejects.toThrow('CLAIM_DEADLINE');
});
it('service reserve uses post-wait expiry/period and keeps immutable input replay hash',async()=>{
  const s=await fixture(base,25);const blocked=new LedgerService(busyOnce(s.db),enforcementCatalogue,categoryMap,s.timing, 'demo-merchant');
  await expect(blocked.reserve(s.ctx(),proposal,s.hash,true)).rejects.toThrow('MANDATE_NOT_ACTIVE');
  const t=await fixture(Date.parse('2026-10-18T15:59:59.990Z'));const service=new LedgerService(busyOnce(t.db),enforcementCatalogue,categoryMap,t.timing, 'demo-merchant');
  const context=t.ctx();const a=await service.reserve(context,proposal,t.hash,true),b=await service.reserve(context,proposal,t.hash,true);
  expect(a).toEqual(b);expect(budget(t.db,'owner',weeklyPeriod(t.clock.wall).periodKey).reservedMinor).toBe(1750);
});
it('never resets monotonic transaction parent budget across BUSY retries or clock rollback',async()=>{
  const s=await fixture();const timing={clock:s.clock,parentDeadlineMono:200,wait:async()=>s.clock.advance(-1000,250)};
  await expect(withImmediate(busyOnce(s.db),()=>{throw new Error('SHOULD_NOT_RUN_AFTER_PARENT_DEADLINE');},timing)).rejects.toThrow('DB_BUSY');
});
it('compiler finish and GET horizon use transaction-time server clock after retry',async()=>{
  const s=await fixture();const key=randomUUID();const token=immediate(s.db,()=>claimLease(s.db,'compile',key,{},s.clock));
  s.clock.advance(65000-25);
  const proxy=busyOnce(s.db);
  await expect(withImmediate(proxy,()=>finishLease(proxy,'compile',key,token,{ok:true},s.clock),s.timing)).rejects.toThrow('STALE_LEASE');
  const t=await fixture();await claimOperation(t.db,t.op.id,t.input,{clock:t.clock});
  immediate(t.db,()=>recordOperationPending(t.db,t.op.id,t.clock));
  const horizon=Number(one(t.db,'SELECT horizon_until FROM operations WHERE id=?',t.op.id)?.['horizon_until']);
  t.clock.advance(horizon-t.clock.wall-25);const getDb=busyOnce(t.db);
  const admitted=await withImmediate(getDb,()=>claimAutomaticGetAttempt(getDb,t.op.id,'CAP-1',t.clock),t.timing);
  expect(admitted).toBe(false);expect(one(t.db,'SELECT state,get_attempts FROM operations WHERE id=?',t.op.id)).toMatchObject({state:'MANUAL',get_attempts:0});
});
it('pending lifecycle preserves bounded GET eligibility and actual claim time/sequence',async()=>{
  const s=await fixture();await claimOperation(busyOnce(s.db),s.op.id,s.input,s.timing);
  const claimed=one(s.db,'SELECT claimed_at,attempt,horizon_until FROM operations WHERE id=?',s.op.id)!;
  expect(claimed['claimed_at']).toBe(base+50);expect(claimed['attempt']).toBe(1);
  immediate(s.db,()=>recordOperationPending(s.db,s.op.id,s.clock));s.clock.advance(60000);
  expect(immediate(s.db,()=>claimAutomaticGetAttempt(s.db,s.op.id,'CAP-1',s.clock))).toBe(true);
  expect(one(s.db,'SELECT state,horizon_until FROM operations WHERE id=?',s.op.id)).toMatchObject({state:'UNKNOWN',horizon_until:claimed['horizon_until']});
});

it('short session remaining caps BOTH permit clocks from one claim sample despite wall rollback',async()=>{
  const s=await fixture();
  const permit=await claimOperation(s.db,s.op.id,{...s.input,sessionExpiresAt:base+1000},{clock:s.clock});
  expect(permit).not.toBeNull();
  expect(one(s.db,'SELECT send_deadline FROM operations WHERE id=?',s.op.id)?.['send_deadline']).toBe(base+1000);
  s.clock.advance(500,500);s.clock.advance(-400,100);s.clock.advance(500,500);
  expect(s.clock.wall).toBe(base+600);expect(s.clock.mono).toBe(1100);
  expect(()=>consumeSendPermit(permit!)).toThrow('SEND_PERMIT_SPENT_OR_EXPIRED');
});
