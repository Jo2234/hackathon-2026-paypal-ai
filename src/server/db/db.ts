import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { systemClock } from '../../shared/clock.ts';
import type { ServerClock } from '../../shared/clock.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { LIMITS } from '../../shared/limits.ts';
export type Db = DatabaseSync;
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}
const activeTransactions = new WeakSet<Db>();
export function assertTransaction(db: Db): void { if (!activeTransactions.has(db)) throw new Error('IMMEDIATE_TRANSACTION_REQUIRED'); }
export type TransactionTiming=Readonly<{clock?:ServerClock;parentDeadlineMono?:number;wait?:(milliseconds:number)=>Promise<void>}>;
export function immediate<T>(db: Db, action: () => T, timing:TransactionTiming={}): T {
  const clock=timing.clock??systemClock;
  const deadline=timing.parentDeadlineMono??clock.monotonicNow()+LIMITS.dbDeadlineMs;
  if (activeTransactions.has(db)) throw new Error('NESTED_TRANSACTION');
  db.exec('BEGIN IMMEDIATE'); activeTransactions.add(db);
  try {
    if(clock.monotonicNow()>=deadline)throw new Error('DB_DEADLINE_503');
    const value = action();
    if (value && typeof value === 'object' && 'then' in value) throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
    if (clock.monotonicNow() >= deadline) throw new Error('DB_DEADLINE_503');
    db.exec('COMMIT'); return value;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { activeTransactions.delete(db); }
}
function busy(error: unknown): boolean { return error instanceof Error && ('errcode' in error ? [5,6].includes(error.errcode as number) : /database (?:is )?(?:locked|busy)/i.test(error.message)); }
// Await/backoff is outside BEGIN/ROLLBACK. The callback must contain only synchronous DB/pure work.
export async function withImmediate<T>(db: Db, action: () => T, timing:TransactionTiming={}): Promise<T> {
  const clock=timing.clock??systemClock;
  // Frozen once at admission, never recreated by a BUSY retry.
  const deadline = Math.min(timing.parentDeadlineMono??Infinity,clock.monotonicNow() + LIMITS.dbDeadlineMs);
  for (let attempt = 0; ; attempt++) {
    if (clock.monotonicNow() >= deadline) throw new Error('DB_BUSY_503');
    try { return immediate(db, action, {clock,parentDeadlineMono:deadline}); }
    catch (error) {
      const backoff = LIMITS.dbRetryBackoffsMs[attempt];
      if (!busy(error)) throw error;
      if (backoff === undefined || clock.monotonicNow() + backoff + LIMITS.dbBusyMs >= deadline) throw new Error('DB_BUSY_503');
      await (timing.wait??delay)(backoff);
    }
  }
}
