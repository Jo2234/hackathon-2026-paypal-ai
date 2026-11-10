import type { Db } from '../../server/db/db.ts';
import { all, budget, int, one, text } from '../../server/db/repo.ts';
import { assertMinor } from '../money.ts';
export function assertLedgerInvariants(db:Db):void {
  const equal=(actual:number,expected:number,label:string)=>{assertMinor(actual,true);assertMinor(expected,true);if(actual!==expected)throw new Error(`INVARIANT:${label}:${actual}!=${expected}`);};
  for(const row of all(db,'SELECT owner_id,period_key FROM budget_buckets')) {
    const owner=text(row,'owner_id'),period=text(row,'period_key'),b=budget(db,owner,period);
    const sum=(sql:string)=>int(one(db,sql,owner,period)!,'n');
    equal(b.reservedMinor,sum('SELECT COALESCE(SUM(hold_minor),0) AS n FROM reservations WHERE owner_id=? AND period_key=?'),'I2');
    equal(b.capturedMinor,sum('SELECT COALESCE(SUM(captured_minor),0) AS n FROM reservations WHERE owner_id=? AND period_key=?'),'I3_reservations');
    equal(b.capturedMinor,sum('SELECT COALESCE(SUM(c.amount_minor),0) AS n FROM provider_captures c JOIN reservations r ON r.id=c.reservation_id WHERE r.owner_id=? AND r.period_key=?'),'I3_facts');
    equal(b.refundedCompletedMinor,sum('SELECT COALESCE(SUM(f.amount),0) AS n FROM refunds f JOIN reservations r ON r.id=f.reservation_id WHERE r.owner_id=? AND r.period_key=? AND f.completed_applied=1'),'I4_refunded');
    equal(b.restoredMinor,sum("SELECT COALESCE(SUM(f.amount),0) AS n FROM refunds f JOIN reservations r ON r.id=f.reservation_id WHERE r.owner_id=? AND r.period_key=? AND f.completed_applied=1 AND r.restoration='restore_on_completed_refund'"),'I4_restored');
    equal(b.externalRefundedMinor,sum('SELECT COALESCE(SUM(f.amount_minor),0) AS n FROM provider_refund_facts f JOIN provider_captures c ON c.capture_id=f.capture_id JOIN reservations r ON r.id=c.reservation_id WHERE r.owner_id=? AND r.period_key=? AND f.local_refund_id IS NULL'),'I5_external');
    if(b.restoredMinor>b.refundedCompletedMinor || (b.availableMinor<0 && !b.spendBlocked))throw new Error('INVARIANT:I1');
  }
  for(const r of all(db,'SELECT * FROM reservations')) {
    const id=text(r,'id');
    equal(int(r,'captured_minor'),int(one(db,'SELECT COALESCE(SUM(amount_minor),0) AS n FROM provider_captures WHERE reservation_id=?',id)!,'n'),'I3_each_reservation');
    equal(int(r,'external_refunded_minor'),int(one(db,'SELECT COALESCE(SUM(f.amount_minor),0) AS n FROM provider_refund_facts f JOIN provider_captures c USING(capture_id) WHERE c.reservation_id=? AND f.local_refund_id IS NULL',id)!,'n'),'I5_each_external');
    equal(int(r,'amount'),int(one(db,'SELECT COALESCE(SUM(line_minor),0)+500 AS n FROM reservation_lines WHERE reservation_id=?',id)!,'n'),'I11_lines');
  }
  if(one(db,"SELECT 1 FROM refunds f LEFT JOIN provider_refund_facts p ON p.local_refund_id=f.id WHERE f.completed_applied=1 AND (p.refund_id IS NULL OR p.refund_id IS NOT f.provider_refund_id OR p.amount_minor!=f.amount OR p.capture_id!=f.capture_id)"))throw new Error('INVARIANT:I8_correlated_fact');
  for(const row of all(db,'SELECT capture_id,reservation_id,amount_minor FROM provider_captures')) {
    const id=text(row,'capture_id'),amount=int(row,'amount_minor');
    const completed=int(one(db,'SELECT COALESCE(SUM(amount_minor),0) AS n FROM provider_refund_facts WHERE capture_id=?',id)!,'n');
    const pending=int(one(db,"SELECT COALESCE(SUM(amount),0) AS n FROM refunds WHERE capture_id=? AND state IN('REQUESTED','SUBMITTING','PROVIDER_PENDING','REFUND_UNKNOWN')",id)!,'n');
    if(BigInt(completed)+BigInt(pending)>BigInt(amount) && !one(db,'SELECT 1 FROM reservations WHERE id=? AND anomaly_open=1',text(row,'reservation_id'))) throw new Error('INVARIANT:I5');
  }
  if(one(db,"SELECT 1 FROM refunds WHERE completed_applied=1 AND state!='COMPLETED'"))throw new Error('INVARIANT:I8');
  if(one(db,"SELECT 1 FROM operations WHERE attempt>1 OR (attempt=1 AND state='READY')"))throw new Error('INVARIANT:I13');
}
