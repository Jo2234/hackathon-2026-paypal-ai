import { createHash } from 'node:crypto';
import type { Db } from '../db/db.ts';
import { withImmediate } from '../db/db.ts';
import { blockOwner, int, one, run, text } from '../db/repo.ts';
import { LIMITS } from '../../shared/limits.ts';
import type { FixtureWebhookVerifier } from './fixture-verifier.ts';
import { object, resourceId } from '../paypal/provider.ts';

const EVENTS:Readonly<Record<string,'order'|'capture'|'refund'>>=Object.freeze({
  'CHECKOUT.ORDER.APPROVED':'order','PAYMENT.CAPTURE.COMPLETED':'capture','PAYMENT.CAPTURE.PENDING':'capture','PAYMENT.CAPTURE.DECLINED':'capture','PAYMENT.CAPTURE.REFUNDED':'capture','PAYMENT.CAPTURE.REVERSED':'capture','PAYMENT.REFUND.PENDING':'refund','PAYMENT.REFUND.FAILED':'refund',
});
type ParsedDelivery=Readonly<{malformed:true;id:string|null}>|Readonly<{malformed:false;id:string;type:string;kind:'order'|'capture'|'refund'|undefined;subject:string|null}>;
function parseDelivery(raw:Uint8Array):ParsedDelivery {
  let id:string|null=null;
  // Keep the existing envelope checks: unknown event names are retained only;
  // a known hint additionally needs a resource object and bounded resource id.
  // This catch contains only decoding/JSON/envelope validation, never storage
  // or verification. Unsupported hints are not malformed JSON.
  try {
    const parsed=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
    id=resourceId(parsed['id']);const type=String(parsed['event_type']),kind=EVENTS[type];
    const subject=kind?resourceId(object(parsed['resource'])['id']):null;
    return {malformed:false,id,type,kind,subject};
  } catch {return {malformed:true,id};}
}
export class FixtureWebhookInbox {
  readonly db:Db;
  readonly ownerId:string;
  readonly verifier:FixtureWebhookVerifier|undefined;
  constructor(db:Db,ownerId:string,verifier?:FixtureWebhookVerifier) {this.db=db;this.ownerId=ownerId;this.verifier=verifier;}
  async receive(raw:Uint8Array,headers:Headers,now:number,fixtureRoute:boolean):Promise<Readonly<{verification:'UNVERIFIED'|'INVALID'|'VERIFIED';duplicate:boolean;malformed:boolean}>> {
    if(raw.length>LIMITS.webhookBodyBytes) throw new Error('WEBHOOK_BODY_CAP_413');
    const verified=fixtureRoute && this.verifier?.verify(raw,headers)===true;
    const parsed=parseDelivery(raw),{id,malformed}=parsed;
    const verification=malformed?'INVALID':!fixtureRoute?'UNVERIFIED':verified?'VERIFIED':'INVALID';
    const bodyHash=createHash('sha256').update(raw).digest('hex');
    return withImmediate(this.db,()=>{
      const used=one(this.db,'SELECT COUNT(*) AS n,COALESCE(SUM(length(raw_body)),0) AS bytes FROM webhook_deliveries')!;
      // Backpressure, never delete pending/dedupe identities to make room.
      if(int(used,'n')>=LIMITS.deliveries || int(used,'bytes')+raw.length>LIMITS.inboxBytes) throw new Error('WEBHOOK_INBOX_FULL_503');
      const allowed=fixtureRoute?['x-fixture-transmission-id','x-fixture-transmission-time']:['paypal-transmission-id','paypal-transmission-time','paypal-auth-algo'];
      const metadata=Object.fromEntries(allowed.map(k=>[k,(headers.get(k)??'').slice(0,256)]));
      run(this.db,'INSERT INTO webhook_deliveries(event_id,transmission_id,received_at,verification_state,verify_reason,body_hash,raw_body,allowlisted_headers) VALUES(?,?,?,?,?,?,?,?)',id,(headers.get(fixtureRoute?'x-fixture-transmission-id':'paypal-transmission-id')??'').slice(0,128),now,verification,malformed?'malformed JSON or webhook envelope':fixtureRoute?'fixture HMAC protocol only; never PayPal certificate verification':'sandbox certificate verification not implemented; fail closed',bodyHash,raw,JSON.stringify(metadata));
      if(parsed.malformed || verification!=='VERIFIED' || !parsed.kind || !parsed.subject) return {verification,duplicate:false,malformed};
      const {kind,subject,type}=parsed;
      const old=one(this.db,'SELECT * FROM webhook_events WHERE event_id=?',id);
      if(old) {
        if(text(old,'body_hash')!==bodyHash || text(old,'resource_type')!==kind || text(old,'resource_id')!==subject) {run(this.db,"UPDATE webhook_events SET state='CONFLICT' WHERE event_id=?",id);blockOwner(this.db,this.ownerId,'WEBHOOK_VERIFIED_CONFLICT');}
        return {verification,duplicate:true,malformed};
      }
      const seq=int(one(this.db,'SELECT last_insert_rowid() AS n')!,'n');
      if(int(one(this.db,"SELECT COUNT(*) AS n FROM reconcile_jobs WHERE state IN('PENDING','ACTIVE')")!,'n')>=LIMITS.jobs) throw new Error('RECONCILE_QUEUE_FULL_503');
      run(this.db,"INSERT INTO webhook_events(event_id,verified_delivery_seq,body_hash,state,resource_type,resource_id,created_at) VALUES(?,?,?,'PENDING',?,?,?)",id,seq,bodyHash,kind,subject,now);
      run(this.db,"INSERT INTO reconcile_jobs(subject_type,subject_id,state,deadline,next_at) VALUES(?,?,'PENDING',?,?) ON CONFLICT(subject_type,subject_id) DO UPDATE SET state=CASE WHEN reconcile_jobs.state='ACTIVE' THEN 'ACTIVE' ELSE 'PENDING' END",kind,subject,now+LIMITS.autoGet.horizonMs,now);
      if(type==='PAYMENT.CAPTURE.REVERSED'||type==='PAYMENT.CAPTURE.REFUNDED') blockOwner(this.db,this.ownerId,'WEBHOOK_SAFETY_HINT');
      return {verification,duplicate:false,malformed};
    });
  }
}
