import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertUuidV4 } from '../shared/canonical.ts';
import { LIMITS } from '../shared/limits.ts';
import { serverNow, systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import { systemTimers } from './request-control.ts';
import type { Timers } from './request-control.ts';
import type { Deadline } from '../shared/io-contracts.ts';

const COOKIE='mandate_owner';
function equal(a:string,b:string):boolean { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y); }
export type OwnerSession = Readonly<{expiresAt:number;deadlineMono:number}>;
// Generated on explicit construction/bootstrap only, never read from disk/env or logged.
export class LocalSession {
  readonly host:string;
  readonly origin:string;
  readonly clock:ServerClock;
  private readonly returnSecret=randomBytes(32);
  private token='';
  private nonce='';
  private born=0;
  private touched=0;
  private lastWall=0;
  private lastMono=0;
  constructor(host='127.0.0.1:8787',clock:ServerClock=systemClock) {
    if(!['127.0.0.1:8787','127.0.0.1:5173'].includes(host)) throw new Error('EXACT_LOOPBACK_HOST_REQUIRED');
    this.host=host;this.origin=`http://${host}`;this.clock=clock;
  }
  boundary(request:Request):void {
    const h=request.headers;
    let bytes=0; for(const [k,v] of h) bytes+=Buffer.byteLength(k)+Buffer.byteLength(v)+4;
    if(bytes>LIMITS.headersBytes) throw new Error('HEADERS_CAP_431');
    if(h.get('host')!==this.host) throw new Error('HOST_FORBIDDEN_403');
    const site=h.get('sec-fetch-site');
    if(site!==null && !['same-origin','none'].includes(site)) throw new Error('FETCH_SITE_FORBIDDEN_403');
    const origin=h.get('origin');
    if(origin!==null && origin!==this.origin) throw new Error('ORIGIN_FORBIDDEN_403');
  }
  private now():number {
    const now=serverNow(this.clock),mono=this.clock.monotonicNow();
    if(now<this.lastWall || mono<this.lastMono) { this.token='';this.nonce='';throw new Error('SESSION_CLOCK_ROLLBACK_403'); }
    this.lastWall=now;this.lastMono=mono;return now;
  }
  private live(now:number):boolean { return !!this.token && now<this.born+LIMITS.session.absoluteMs && now<this.touched+LIMITS.session.idleMs; }
  private cookie(request:Request):string {
    const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${COOKIE}=`));
    return values.length===1?values[0]!.slice(COOKIE.length+1):'';
  }
  bootstrap(request:Request):Readonly<{csrfNonce:string;cookie:string;expiresAt:number}> {
    this.boundary(request);
    // Same-origin fetch in a browser, or explicit Origin for CLI/injected tests.
    if(request.headers.get('sec-fetch-site')!=='same-origin' && request.headers.get('origin')!==this.origin) throw new Error('BOOTSTRAP_SAME_ORIGIN_REQUIRED_403');
    const now=this.now();
    if(this.live(now) && !equal(this.cookie(request),this.token)) throw new Error('SESSION_ALREADY_BOUND_403');
    if(!this.live(now)) { this.token=randomBytes(32).toString('hex');this.nonce=randomBytes(32).toString('hex');this.born=now; }
    this.touched=now;
    return {csrfNonce:this.nonce,cookie:`${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((this.born+LIMITS.session.absoluteMs-now)/1000)}`,expiresAt:this.born+LIMITS.session.absoluteMs};
  }
  authorize(request:Request,mutation:boolean,durationMs:number=LIMITS.mutationMs):OwnerSession {
    this.boundary(request);const now=this.now();
    if(!this.live(now) || !equal(this.cookie(request),this.token)) throw new Error('SESSION_EXPIRED_403');
    if(mutation) {
      if(request.headers.get('origin')!==this.origin) throw new Error('ORIGIN_REQUIRED_403');
      if(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new Error('JSON_CONTENT_TYPE_REQUIRED_415');
      if(!equal(request.headers.get('x-csrf-nonce')??'',this.nonce)) throw new Error('CSRF_FORBIDDEN_403');
      assertUuidV4(request.headers.get('idempotency-key')??'');
    }
    this.touched=now;
    const expiresAt=Math.min(this.born+LIMITS.session.absoluteMs,now+LIMITS.session.idleMs);
    return {expiresAt,deadlineMono:this.clock.monotonicNow()+Math.min(durationMs,expiresAt-now)};
  }
  // Cross-site callback exception: check the existing owner cookie without
  // bootstrapping or extending its lifetime. Navigation alone grants no session.
  callbackSession(request:Request):OwnerSession|null {
    const now=serverNow(this.clock),mono=this.clock.monotonicNow();
    if(request.headers.get('host')!==this.host || now<this.lastWall || mono<this.lastMono || !this.live(now) || !equal(this.cookie(request),this.token))return null;
    const expiresAt=Math.min(this.born+LIMITS.session.absoluteMs,this.touched+LIMITS.session.idleMs);
    return {expiresAt,deadlineMono:mono+Math.min(LIMITS.get.attemptMs,expiresAt-now)};
  }
  returnState(reservationId:string,orderId:string):string { return createHmac('sha256',this.returnSecret).update(JSON.stringify([reservationId,orderId])).digest('hex'); }
  verifyReturn(reservationId:string,orderId:string,state:string):boolean { return /^[a-f0-9]{64}$/.test(state) && equal(state,this.returnState(reservationId,orderId)); }
}

export type DeadlineScope = Deadline & Readonly<{close:()=>void}>;
export function deadlineScope(parent:AbortSignal,endsAt:number,clock:ServerClock=systemClock,timers:Timers=systemTimers):DeadlineScope {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  parent.addEventListener('abort',abort,{once:true});
  if(parent.aborted) abort();
  const timer=timers.set(abort,Math.max(0,endsAt-clock.monotonicNow()));
  return {monotonicEndsAt:endsAt,signal:controller.signal,close:()=>{timers.clear(timer);parent.removeEventListener('abort',abort);}};
}
export function assertDeadline(deadline:Deadline,clock:ServerClock=systemClock):void {
  if(deadline.signal.aborted || clock.monotonicNow()>=deadline.monotonicEndsAt) throw new Error('REQUEST_DEADLINE_504');
}
// Read and cleanup share the ORIGINAL deadline. All read/cancel rejections are
// observed; no cancellation promise is adopted without a finite race. Unknown
// cleanup is sticky for the owning app, and never described as proven release.
export type BodyControl=Readonly<{timers?:Timers;onUnreleased?:()=>void}>;
export async function readBody(request:Pick<Request,'headers'|'body'>,deadline:Deadline,cap:number=LIMITS.requestBytes,clock:ServerClock=systemClock,control:BodyControl={}):Promise<Uint8Array> {
  if(!Number.isSafeInteger(cap)||cap<0||cap>LIMITS.webhookBodyBytes)throw new Error('REQUEST_BODY_CAP_413');
  const length=request.headers.get('content-length');
  const invalidLength=length!==null && (!/^\d+$/.test(length) || BigInt(length)>BigInt(cap));
  assertDeadline(deadline,clock);
  if(!request.body){if(invalidLength)throw new Error('REQUEST_BODY_CAP_413');return new Uint8Array();}
  const timers=control.timers??systemTimers;
  let reader:ReadableStreamDefaultReader<Uint8Array>;
  try {reader=request.body.getReader();}catch {control.onUnreleased?.();throw new Error('REQUEST_CLEANUP_UNKNOWN_503');}
  const buffer=new Uint8Array(cap);let size=0,pulls=0,reading=false,terminal=false,cancelStarted=false,cancelSettled=false,cancelOK=false;
  let stopped=false,rejectRead:((error:Error)=>void)|undefined,timer:unknown;
  const stopRead=()=>{stopped=true;rejectRead?.(new Error('REQUEST_DEADLINE_504'));};
  let cancelPromise:Promise<void>|undefined;
  const cancel=()=>{
    if(cancelStarted || terminal)return;cancelStarted=true;
    try {cancelPromise=Promise.resolve(reader.cancel('request stopped')).then(()=>{cancelSettled=true;cancelOK=true;},()=>{cancelSettled=true;});}
    catch {cancelSettled=true;cancelOK=false;cancelPromise=Promise.resolve();}
  };
  const abort=()=>{stopRead();cancel();};
  deadline.signal.addEventListener('abort',abort,{once:true});
  timer=timers.set(abort,Math.max(0,deadline.monotonicEndsAt-clock.monotonicNow()));
  if(deadline.signal.aborted)abort();
  let failure:unknown,result:Uint8Array|undefined;
  try {
    if(invalidLength)throw new Error('REQUEST_BODY_CAP_413');
    while(true) {
      assertDeadline(deadline,clock);
      if(stopped)throw new Error('REQUEST_DEADLINE_504');
      // At most cap byte-bearing pulls plus EOF. Empty-chunk abuse cannot create
      // an unlimited microtask loop, or a retained abort-race handler per pull.
      if(++pulls>cap+1)throw new Error('REQUEST_BODY_READ_FAILED_400');
      reading=true;
      const next=await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve,reject)=>{
        rejectRead=reject;
        try {void Promise.resolve(reader.read()).then(value=>{reading=false;rejectRead=undefined;resolve(value);},()=>{reading=false;terminal=true;rejectRead=undefined;reject(new Error('REQUEST_BODY_READ_FAILED_400'));});}
        catch {reading=false;terminal=true;rejectRead=undefined;reject(new Error('REQUEST_BODY_READ_FAILED_400'));}
      });
      assertDeadline(deadline,clock);
      if(next.done){terminal=true;break;}
      if(!(next.value instanceof Uint8Array))throw new Error('REQUEST_BODY_READ_FAILED_400');
      if(next.value.byteLength>cap-size)throw new Error('REQUEST_BODY_CAP_413');
      buffer.set(next.value,size);size+=next.value.byteLength;
    }
    result=buffer.subarray(0,size);
  } catch(error) {failure=error;cancel();}
  finally {
    // Observe already queued settlement reactions before deciding release truth.
    await Promise.resolve();
    // Early abort/oversize can leave time for cleanup, but never creates a new budget.
    if(cancelPromise && !cancelSettled && clock.monotonicNow()<deadline.monotonicEndsAt) {
      await new Promise<void>(resolve=>{
        let done=false,cleanupTimer:unknown;
        const finish=()=>{if(done)return;done=true;timers.clear(cleanupTimer);resolve();};
        cleanupTimer=timers.set(finish,Math.max(0,deadline.monotonicEndsAt-clock.monotonicNow()));
        void cancelPromise!.then(finish); // cancelPromise has already consumed rejection
      });
    }
    deadline.signal.removeEventListener('abort',abort);timers.clear(timer);
    let released=false;
    if(!reading)try {reader.releaseLock();released=true;}catch { /* fixed error only */ }
    if(!released || cancelStarted && (!cancelSettled || !cancelOK)) {
      control.onUnreleased?.();failure??=new Error('REQUEST_CLEANUP_UNKNOWN_503');
    }
  }
  if(failure)throw failure;
  if(stopped)throw new Error('REQUEST_DEADLINE_504');
  return result!;
}
export async function readJson(request:Request,deadline:Deadline,clock:ServerClock=systemClock,control:BodyControl={}):Promise<unknown> {
  const bytes=await readBody(request,deadline,LIMITS.requestBytes,clock,control);
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch {throw new Error('JSON_INVALID_400');}
}
