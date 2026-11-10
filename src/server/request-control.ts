import { LIMITS } from '../shared/limits.ts';
import { systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';

// Pure control definitions. Timers can be injected; no DB, listener, FS or transport.
export type Timers=Readonly<{set:(action:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void}>;
export const systemTimers:Timers={set:(action,ms)=>setTimeout(action,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
export class FailureLatch {
  private value:'STORAGE_READ_ONLY_503'|'REQUEST_CLEANUP_UNKNOWN_503'|'SHUTDOWN_UNKNOWN_503'|null=null;
  private unresolved=false;
  get reason(){return this.value;}
  get unknown():boolean {return this.unresolved;}
  fail(reason:NonNullable<FailureLatch['reason']>):void {this.value??=reason;if(reason!=='STORAGE_READ_ONLY_503')this.unresolved=true;}
  observe(error:unknown):void {
    if(!error || typeof error!=='object')return;
    try {
    const e=error as {errcode?:unknown;code?:unknown};
    // SQLite extended codes retain their base in the low byte. No message parsing,
    // exception text, body data or impossible durable disk-full audit promise.
    if(typeof e.errcode==='number' && Number.isInteger(e.errcode) && [8,10,11,13,14,26].includes(e.errcode & 255) || typeof e.code==='string' && /^(?:SQLITE_(?:READONLY|IOERR|CORRUPT|FULL|CANTOPEN|NOTADB)(?:_[A-Z0-9]+)?|ENOSPC|EIO|EROFS)$/.test(e.code))this.fail('STORAGE_READ_ONLY_503');
    }catch { /* Hostile exception accessors cannot create an unobserved rejection. */ }
  }
  assertWritable():void {if(this.value)throw new Error(this.value);}
}
export type DrainResult=Readonly<{state:'drained'|'unknown';pending:number;endsAt:number}>;
export class RequestOwnership {
  readonly failures:FailureLatch;
  private readonly clock:ServerClock;
  private readonly timers:Timers;
  private readonly lifetime=new AbortController();
  private readonly active=new Set<Readonly<{controller:AbortController;promise:Promise<unknown>}>>();
  private stopped=false;
  private drainPromise:Promise<DrainResult>|undefined;
  constructor(clock:ServerClock=systemClock,failures=new FailureLatch(),timers:Timers=systemTimers) {this.clock=clock;this.failures=failures;this.timers=timers;}
  get pending():number {return this.active.size;}
  get closing():boolean {return this.stopped;}
  stopAdmission():void {this.stopped=true;this.lifetime.abort();for(const entry of this.active)entry.controller.abort();}
  run<T>(parent:AbortSignal,action:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    if(this.stopped)return Promise.reject(new Error('SERVER_STOPPING_503'));
    try {this.failures.assertWritable();}catch(error){return Promise.reject(error);}
    if(this.active.size>=LIMITS.queue)return Promise.reject(new Error('REQUEST_QUEUE_FULL_503'));
    const controller=new AbortController(),abort=()=>controller.abort();
    parent.addEventListener('abort',abort,{once:true});
    if(parent.aborted || this.lifetime.signal.aborted)abort();
    // Actual admitted action promise is retained until it settles, even if its
    // caller stops waiting. Both rejection branches are observed immediately.
    const promise=Promise.resolve().then(()=>action(controller.signal));
    const entry={controller,promise};this.active.add(entry);
    const settled=()=>{parent.removeEventListener('abort',abort);this.active.delete(entry);};
    void promise.then(settled,error=>{this.failures.observe(error);settled();});
    return promise;
  }
  drain(parentEndsAt?:number):Promise<DrainResult> {
    if(this.drainPromise)return this.drainPromise;
    if(parentEndsAt!==undefined && !Number.isFinite(parentEndsAt))throw new Error('SHUTDOWN_DEADLINE_INVALID');
    const endsAt=Math.min(parentEndsAt??Infinity,this.clock.monotonicNow()+LIMITS.shutdownMs);
    this.stopAdmission();
    this.drainPromise=new Promise(resolve=>{
      let finished=false,timer:unknown;
      const finish=(expired:boolean)=>{
        if(finished)return;finished=true;this.timers.clear(timer);
        const pending=this.pending;
        if(expired && pending)this.failures.fail('SHUTDOWN_UNKNOWN_503');
        resolve({state:pending?'unknown':'drained',pending,endsAt});
      };
      timer=this.timers.set(()=>finish(true),Math.max(0,endsAt-this.clock.monotonicNow()));
      void Promise.all([...this.active].map(entry=>entry.promise.then(()=>undefined,()=>undefined))).then(()=>finish(false));
    });
    return this.drainPromise;
  }
}
