import type { SQLInputValue } from 'node:sqlite';
import type { AnomalyReason, BudgetSnapshot, FactEvidence, LedgerKind, MandatePolicy, Operation, Refund, Reservation } from '../../shared/types.ts';
import { assertMinor, addMinor } from '../../domain/money.ts';
import { canonicalJson } from '../../shared/canonical.ts';
import { immediate, assertTransaction } from './db.ts';
import type { Db } from './db.ts';
export type Row = Record<string, unknown>;
export function one(db: Db, sql: string, ...values: SQLInputValue[]): Row | undefined { return db.prepare(sql).get(...values); }
export function all(db: Db, sql: string, ...values: SQLInputValue[]): Row[] { return db.prepare(sql).all(...values); }
export function run(db: Db, sql: string, ...values: SQLInputValue[]): number { assertTransaction(db); return Number(db.prepare(sql).run(...values).changes); }
export function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error(`DB_TEXT:${key}`); return value; }
export function int(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`DB_INTEGER:${key}`); return value; }
export function minor(row: Row, key: string): number { return assertMinor(int(row,key), true); }
function nullableText(row: Row, key: string): string | null { return row[key] === null ? null : text(row,key); }
function nullableInt(row: Row, key: string): number | null { return row[key] === null ? null : int(row,key); }
export function json<T>(row: Row, key: string): T { return JSON.parse(text(row,key)) as T; }
export function ensureOwner(db: Db, ownerId: string): void { run(db,'INSERT INTO owner_state(owner_id) VALUES(?) ON CONFLICT DO NOTHING',ownerId); }
export function blockOwner(db: Db, ownerId: string, reason: string): void {
  ensureOwner(db,ownerId); const row = one(db,'SELECT reasons FROM owner_state WHERE owner_id=?',ownerId)!;
  const reasons = [...new Set([...json<string[]>(row,'reasons'),reason])];
  run(db,'UPDATE owner_state SET spend_blocked=1,reasons=? WHERE owner_id=?',canonicalJson(reasons),ownerId);
}
export function activePolicy(db: Db, ownerId: string): MandatePolicy | null {
  const row = one(db,"SELECT policy_json,status FROM mandates WHERE owner_id=? AND status='ACTIVE'",ownerId);
  return row ? { ...json<MandatePolicy>(row,'policy_json'), status: 'ACTIVE' } : null;
}
export function latestPolicy(db: Db, ownerId: string): MandatePolicy | null {
  const row = one(db,'SELECT policy_json,status FROM mandates WHERE owner_id=? ORDER BY rowid DESC LIMIT 1',ownerId);
  return row ? { ...json<MandatePolicy>(row,'policy_json'), status: text(row,'status') as MandatePolicy['status'] } : null;
}
export function budget(db: Db, ownerId: string, periodKey: string): BudgetSnapshot {
  const row = one(db,'SELECT b.*,o.spend_blocked,o.reasons FROM budget_buckets b JOIN owner_state o USING(owner_id) WHERE owner_id=? AND period_key=?',ownerId,periodKey);
  if (!row) throw new Error('BUCKET_NOT_FOUND');
  const allowanceMinor=minor(row,'allowance'), reservedMinor=minor(row,'reserved'),capturedMinor=minor(row,'captured'),refundedCompletedMinor=minor(row,'refunded_completed'),restoredMinor=minor(row,'restored'),externalRefundedMinor=minor(row,'external_refunded');
  return { ownerId,periodKey,allowanceMinor,reservedMinor,capturedMinor,refundedCompletedMinor,restoredMinor,externalRefundedMinor,availableMinor:addMinor(allowanceMinor,-reservedMinor,-capturedMinor,restoredMinor),spendBlocked:int(row,'spend_blocked')===1,spendBlockReasons:json<string[]>(row,'reasons') };
}
export function ensureBucket(db: Db, ownerId: string, periodKey: string, allowance: number): void { run(db,'INSERT INTO budget_buckets(owner_id,period_key,allowance) VALUES(?,?,?) ON CONFLICT DO NOTHING',ownerId,periodKey,assertMinor(allowance,true)); }
export function reservation(db: Db, id: string): Reservation {
  const r = one(db,'SELECT * FROM reservations WHERE id=?',id); if (!r) throw new Error('RESERVATION_NOT_FOUND');
  return { id:text(r,'id'),ownerId:text(r,'owner_id'),mandateId:text(r,'mandate_id'),policyVersion:int(r,'policy_version'),policyHash:text(r,'policy_hash'),periodKey:text(r,'period_key'),restoration:text(r,'restoration') as Reservation['restoration'],state:text(r,'state') as Reservation['state'],amount:minor(r,'amount'),holdMinor:minor(r,'hold_minor'),capturedMinor:minor(r,'captured_minor'),externalRefundedMinor:minor(r,'external_refunded_minor'),orderId:nullableText(r,'order_id'),anomalyReasons:json<AnomalyReason[]>(r,'anomaly_reasons'),releaseOnResolve:int(r,'release_on_resolve')===1,createdAt:int(r,'created_at'),updatedAt:int(r,'updated_at') };
}
export function saveReservation(db: Db, r: Reservation): void { run(db,'UPDATE reservations SET state=?,hold_minor=?,captured_minor=?,external_refunded_minor=?,order_id=?,anomaly_open=?,anomaly_reasons=?,release_on_resolve=?,updated_at=? WHERE id=?',r.state,assertMinor(r.holdMinor,true),assertMinor(r.capturedMinor,true),assertMinor(r.externalRefundedMinor,true),r.orderId,r.anomalyReasons.length?1:0,canonicalJson(r.anomalyReasons),r.releaseOnResolve?1:0,r.updatedAt,r.id); }
export function refund(db: Db, id: string): Refund {
  const r=one(db,'SELECT * FROM refunds WHERE id=?',id); if(!r) throw new Error('REFUND_NOT_FOUND');
  return {id:text(r,'id'),captureId:text(r,'capture_id'),reservationId:text(r,'reservation_id'),amount:minor(r,'amount'),state:text(r,'state') as Refund['state'],completedApplied:int(r,'completed_applied')===1,providerRefundId:nullableText(r,'provider_refund_id'),createdAt:int(r,'created_at'),updatedAt:int(r,'updated_at')};
}
export function operation(db: Db, id: string): Operation {
  const r=one(db,'SELECT * FROM operations WHERE id=?',id); if(!r) throw new Error('OPERATION_NOT_FOUND');
  const attempt=int(r,'attempt'); if(attempt!==0 && attempt!==1) throw new Error('OPERATION_ATTEMPT');
  return {id:text(r,'id'),kind:text(r,'kind') as Operation['kind'],subjectId:text(r,'subject_id'),requestId:text(r,'request_id'),canonicalBody:text(r,'canonical_body'),bodyHash:text(r,'body_hash'),state:text(r,'state') as Operation['state'],attempt,ownerToken:nullableText(r,'owner_token'),claimedAt:nullableInt(r,'claimed_at'),sendDeadline:nullableInt(r,'send_deadline'),horizonUntil:nullableInt(r,'horizon_until'),nextGetAt:nullableInt(r,'next_get_at'),getAttempts:int(r,'get_attempts'),expiresAt:int(r,'expires_at'),createdAt:int(r,'created_at'),updatedAt:int(r,'updated_at')};
}
export function captureClaimed(db: Db, id: string): boolean { return !!one(db,"SELECT 1 FROM operations WHERE kind='ORDER_CAPTURE' AND subject_id=? AND attempt=1",id); }
export function observation(db: Db, evidence: FactEvidence): void {
  if (Buffer.byteLength(evidence.boundedRedactedJson)>16384) throw new Error('EVIDENCE_CAP');
  run(db,'INSERT INTO provider_observations(resource_id,payload_hash,bounded_redacted_json,source,observed_at) VALUES(?,?,?,?,?)',evidence.resourceId,evidence.payloadHash,evidence.boundedRedactedJson,evidence.source,evidence.observedAt);
}
export function anomaly(db: Db,r: Reservation,reason: AnomalyReason,now: number): void {
  saveReservation(db,{...r,anomalyReasons:[...new Set([...r.anomalyReasons,reason])],updatedAt:now}); blockOwner(db,r.ownerId,reason);
  audit(db,r,'ANOMALY',0,now,reason);
}
const dbModes=new WeakMap<Db,'fixture'|'sandbox'>();
export function bindLedgerMode(db:Db,mode:'fixture'|'sandbox',merchantId:string):void {
  db.exec('CREATE TABLE IF NOT EXISTS provider_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,merchant_id TEXT NOT NULL) STRICT');
  immediate(db,()=>run(db,'INSERT OR IGNORE INTO provider_binding VALUES(1,?,?)',mode,merchantId));
  const binding=one(db,'SELECT * FROM provider_binding WHERE singleton=1')!;
  if(text(binding,'mode')!==mode || text(binding,'merchant_id')!==merchantId)throw new Error('PERSISTED_PROVIDER_BINDING_MISMATCH');
  dbModes.set(db,mode);
}
export function audit(db: Db, r: Pick<Reservation,'ownerId'|'mandateId'|'policyVersion'|'periodKey'> & Partial<Pick<Reservation,'id'>>, kind: LedgerKind, amount: number, at: number, note: string, source: 'fixture'|'sandbox'=dbModes.get(db)??'fixture', paypal: Record<string,string>={}, rules: readonly string[]=[]): void {
  const b=budget(db,r.ownerId,r.periodKey);
  run(db,'INSERT INTO ledger_rows(at,owner_id,mandate_id,policy_version,period_key,kind,reservation_id,amount_minor,available_after,reserved_after,captured_after,restored_after,refunded_completed_after,rule_ids,paypal,source,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',at,r.ownerId,r.mandateId,r.policyVersion,r.periodKey,kind,r.id??null,assertMinor(amount),b.availableMinor,b.reservedMinor,b.capturedMinor,b.restoredMinor,b.refundedCompletedMinor,canonicalJson(rules),canonicalJson(paypal),source,note);
}
export function blockNegative(db: Db, r: Reservation): void { if (budget(db,r.ownerId,r.periodKey).availableMinor<0) blockOwner(db,r.ownerId,'NEGATIVE_AVAILABLE'); }
