import { randomUUID } from 'node:crypto';
import type { Db } from './db/db.ts';
import { assertTransaction } from './db/db.ts';
import { one,run,text,int } from './db/repo.ts';
import { assertUuidV4, canonicalJson, hashJson } from '../shared/canonical.ts';
import { serverNow,systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import { LIMITS } from '../shared/limits.ts';
export type StoredResponse = Readonly<{ status: number; body: string; effectId: string | null }>;
export function idempotencyScope(ownerId: string, method: string, route: string, subjectId: string): string { return canonicalJson([ownerId,method,route,subjectId]); }
// Caller invokes within the SAME immediate transaction as the effect. Input is validated client input;
// expected hashes must never be replaced by current policy values before this lookup.
export function localEffect(db: Db, scope: string, key: string, input: unknown, now: number, effect: () => Readonly<{status:number;body:unknown;effectId:string|null}>): StoredResponse {
  assertTransaction(db); assertUuidV4(key); const bodyHash=hashJson(input);
  const existing=one(db,'SELECT * FROM idempotency_keys WHERE scope=? AND key=?',scope,key);
  if(existing) {
    if(text(existing,'body_hash')!==bodyHash) throw new Error('IDEMPOTENCY_KEY_REUSE_409');
    if(text(existing,'state')==='TOMBSTONE' || (existing['completed_at']!==null && now-int(existing,'completed_at')>=LIMITS.responseRetentionMs)) throw new Error('IDEMPOTENCY_RESPONSE_EXPIRED_410');
    if(text(existing,'state')!=='COMPLETE') throw new Error('IDEMPOTENCY_IN_PROGRESS_409');
    return {status:int(existing,'response_status'),body:text(existing,'response_json'),effectId:existing['effect_id']===null?null:text(existing,'effect_id')};
  }
  if(int(one(db,'SELECT COUNT(*) AS n FROM idempotency_keys')!,'n')>=LIMITS.idempotencyKeys) throw new Error('IDEMPOTENCY_CAP_503');
  run(db,"INSERT INTO idempotency_keys(scope,key,body_hash,state,created_at) VALUES(?,?,?,'IN_PROGRESS',?)",scope,key,bodyHash,now);
  const result=effect(); const response=canonicalJson(result.body);
  if(Buffer.byteLength(response)>LIMITS.responseBytes) throw new Error('RESPONSE_CAP');
  run(db,"UPDATE idempotency_keys SET state='COMPLETE',response_json=?,response_status=?,effect_id=?,completed_at=? WHERE scope=? AND key=?",response,result.status,result.effectId,now,scope,key);
  return {status:result.status,body:response,effectId:result.effectId};
}
export function pruneResponses(db:Db, now:number):number { return run(db,"UPDATE idempotency_keys SET state='TOMBSTONE',response_json=NULL,response_status=NULL WHERE state='COMPLETE' AND completed_at<=?",now-LIMITS.responseRetentionMs); }
// Non-money compiler/proposal lease only. Old holders must use finishLease's CAS.
export function claimLease(db:Db,scope:string,key:string,input:unknown,clock:ServerClock=systemClock):string {
  assertTransaction(db);const now=serverNow(clock);assertUuidV4(key); const bodyHash=hashJson(input); const token=randomUUID();
  const row=one(db,'SELECT * FROM idempotency_keys WHERE scope=? AND key=?',scope,key);
  if(row) {
    if(text(row,'body_hash')!==bodyHash) throw new Error('IDEMPOTENCY_KEY_REUSE_409');
    if(text(row,'state')!=='IN_PROGRESS') throw new Error('IDEMPOTENCY_ALREADY_FINISHED');
    if(row['lease_until']===null || int(row,'lease_until')>now) throw new Error('IDEMPOTENCY_IN_PROGRESS_409');
    run(db,'UPDATE idempotency_keys SET owner_token=?,lease_until=? WHERE scope=? AND key=? AND state=\'IN_PROGRESS\' AND lease_until<=?',token,now+LIMITS.compilerLeaseMs,scope,key,now);
  } else {
    if(int(one(db,'SELECT COUNT(*) AS n FROM idempotency_keys')!,'n')>=LIMITS.idempotencyKeys) throw new Error('IDEMPOTENCY_CAP_503');
    run(db,"INSERT INTO idempotency_keys(scope,key,body_hash,state,owner_token,lease_until,created_at) VALUES(?,?,?,'IN_PROGRESS',?,?,?)",scope,key,bodyHash,token,now+LIMITS.compilerLeaseMs,now);
  }
  return token;
}
export function finishLease(db:Db,scope:string,key:string,token:string,response:unknown,clock:ServerClock=systemClock,status=200):void {
  assertTransaction(db);const now=serverNow(clock);
  const body=canonicalJson(response); if(Buffer.byteLength(body)>LIMITS.responseBytes) throw new Error('RESPONSE_CAP');
  if(run(db,"UPDATE idempotency_keys SET state='COMPLETE',response_status=?,response_json=?,completed_at=? WHERE scope=? AND key=? AND state='IN_PROGRESS' AND owner_token=? AND lease_until>?",status,body,now,scope,key,token,now)!==1) throw new Error('STALE_LEASE');
}
