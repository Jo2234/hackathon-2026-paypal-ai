import { buildDraftPolicy, buildCartProposal } from './llm/narrow.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { FailureLatch, RequestOwnership } from './request-control.ts';
import type { Db } from './db/db.ts';
import { withImmediate } from './db/db.ts';
import { all, audit, bindLedgerMode, budget, int, json, latestPolicy, one, operation, refund, reservation, run, text } from './db/repo.ts';
import { LedgerService } from '../domain/ledger/service.ts';
import type { CommandContext } from '../domain/ledger/service.ts';
import { catalogue, categoryMap, enforcementCatalogue } from '../domain/engine/catalogue.ts';
import { evaluateCart } from '../domain/engine/engine.ts';
import { reviewDiff } from '../domain/policy/diff.ts';
import { safeDefaults, validatePolicy } from '../domain/policy/policy.ts';
import { weeklyPeriod } from '../domain/ledger/period.ts';
import { canonicalJson, hashJson } from '../shared/canonical.ts';
import { randomUUID } from 'node:crypto';
import { compilerFor, infer } from './llm/adapter.ts';
import type { ModelConfig } from './llm/adapter.ts';
import { proposalSchema } from '../shared/schemas.ts';
import type { CartProposal, MandatePolicy } from '../shared/types.ts';
import { LIMITS } from '../shared/limits.ts';
import { serverNow, systemClock } from '../shared/clock.ts';
import type { ServerClock } from '../shared/clock.ts';
import { claimLease, finishLease, localEffect, idempotencyScope } from './idempotency.ts';
import type { StoredResponse } from './idempotency.ts';
import { fixtureLookup } from './llm/fixture.ts';
import type { FixtureRecord } from './llm/fixture.ts';
import compilerFixture from '../../fixtures/llm/compile/office-weekly.json' with {type:'json'};
import restockFixture from '../../fixtures/llm/agent/restock.json' with {type:'json'};
import confusedFixture from '../../fixtures/llm/agent/confused-model.json' with {type:'json'};
import { LocalSession, assertDeadline, deadlineScope, readBody, readJson } from './session.ts';
import { FakePayPal } from './paypal/fake.ts';
import { object, resourceId } from './paypal/provider.ts';
import type { PayPalProvider } from './paypal/provider.ts';
import { createOrderBody } from './paypal/orders.ts';
import { FixtureDispatcher } from './dispatcher.ts';
import { FixtureRecovery } from './recovery.ts';
import { FixtureWebhookInbox } from './webhooks/inbox.ts';
import type { FixtureWebhookVerifier } from './webhooks/fixture-verifier.ts';

function boundedDraft(input:unknown,base:MandatePolicy,now:number):MandatePolicy {
  const candidate=validatePolicy(input,categoryMap,now);
  if(candidate.status!=='DRAFT'||candidate.signedAt!==null||candidate.contentHash!==null)throw new Error('MODEL_OUTPUT_422');
  const limited={...candidate};
  for(const key of ['allowanceMinor','perOrderMaxMinor','perLineMaxMinor','stepUpThresholdMinor','maxQuantityPerLine','maxLinesPerCart'] as const)limited[key]=Math.min(candidate[key],base[key]);
  return validatePolicy(limited,categoryMap,now);
}
function fields(input:unknown,allowed:readonly string[],required:readonly string[]=[]):Record<string,unknown> {
  const value=object(input);if(Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) throw new Error('REQUEST_SCHEMA_422');return value;
}
function string(value:unknown,max:number):string {if(typeof value!=='string'||value.length<1||value.length>max)throw new Error('REQUEST_SCHEMA_422');return value;}
function empty(value:unknown):void {fields(value,[]);}
// Only reviewed public codes are reflected. Arbitrary exception strings, even
// uppercase strings from injected bodies/transports, become REQUEST_FAILED.
const PUBLIC_ERRORS=new Set(`ALLOWANCE_BELOW_USAGE_409 BAD_STATE BUCKET_NOT_FOUND CAPTURE_NOT_FOUND CAPTURE_REFUND_BLOCKED COMMAND_QUEUE_FULL_503 DB_BUSY_503 DB_DEADLINE_503 DISPOSITION_NOT_IMPLEMENTED_422 IDEMPOTENCY_CAP_503 IDEMPOTENCY_IN_PROGRESS_409 IDEMPOTENCY_KEY_REUSE_409 IDEMPOTENCY_RESPONSE_EXPIRED_410 INSUFFICIENT_ALLOWANCE_409 LEDGER_CAP_503 MANDATE_ID_INVALID MANDATE_NOT_ACTIVE MANDATE_NOT_FOUND MANDATE_OWNER_MISMATCH NOT_ACTIVE OPERATION_NOT_FOUND ORDER_NOT_FOUND OWNER_MISMATCH POLICY_CATEGORY_OVERLAP POLICY_DUPLICATE POLICY_EXPIRY POLICY_LIMIT_ORDER POLICY_UNKNOWN_SKU PROVIDER_RESOURCE_ID_INVALID RECONCILE_QUEUE_FULL_503 RECONCILE_RATE_429 RECONCILE_RUNNING_409 REFUND_ACTIVE REFUND_EXCEEDS_REMAINING REFUND_NOT_FOUND REQUEST_SCHEMA_422 RESPONSE_CAP_503 RESERVATION_NOT_FOUND RETURN_STATE_FORBIDDEN_403 SENSITIVE_OWNER_TICK_REQUIRED STALE_POLICY STALE_POLICY_409 STARTING_503 UUID_V4_REQUIRED WEBHOOK_BODY_CAP_413 WEBHOOK_INBOX_FULL_503 BOOTSTRAP_SAME_ORIGIN_REQUIRED_403 CSRF_FORBIDDEN_403 FETCH_SITE_FORBIDDEN_403 HEADERS_CAP_431 HOST_FORBIDDEN_403 JSON_CONTENT_TYPE_REQUIRED_415 JSON_INVALID_400 ORIGIN_FORBIDDEN_403 ORIGIN_REQUIRED_403 REQUEST_BODY_CAP_413 REQUEST_BODY_READ_FAILED_400 REQUEST_CLEANUP_UNKNOWN_503 REQUEST_DEADLINE_504 REQUEST_QUEUE_FULL_503 SERVER_STOPPING_503 SESSION_ALREADY_BOUND_403 SESSION_CLOCK_ROLLBACK_403 SESSION_EXPIRED SESSION_EXPIRED_403 STORAGE_READ_ONLY_503 SHUTDOWN_UNKNOWN_503 FIXTURE_MISS_LLM_UNAVAILABLE MODEL_OUTPUT_422 MODEL_QUOTA_429 MODEL_AUTH_503 MODEL_UNAVAILABLE_503 MODEL_TIMEOUT_504 STALE_LEASE STALE_MODEL_CONTEXT_409`.split(' '));
export type FixtureAppOptions=Readonly<{db:Db;ownerId?:string;host?:string;clock?:ServerClock;provider?:PayPalProvider;webhookVerifier?:FixtureWebhookVerifier;llm?:ModelConfig;modelText?:readonly string[]}>;
export function createFixtureApp(options:FixtureAppOptions) {
  const {db}=options,ownerId=options.ownerId??'demo-owner',clock=options.clock??systemClock;
  const failures=new FailureLatch(),ownership=new RequestOwnership(clock,failures);
  const bodyControl={onUnreleased:()=>failures.fail('REQUEST_CLEANUP_UNKNOWN_503')};
  const session=new LocalSession(options.host??'127.0.0.1:8787',clock);
  const provider=options.provider??new FakePayPal({now:clock.wallNow});
const MODE=Object.freeze({paypal:provider.mode,llm:options.llm?options.llm.mode:'fixture',vault:'off',model:options.llm?.model??'handwritten',digest:options.llm?.digest??null,provider:options.llm?.mode==='hosted'?'groq':options.llm?'local':null,modelIdentity:'configured',origin:options.llm?'live':'handwritten'});
function response(body:unknown,status=200,extra:Readonly<Record<string,string>>={}):Response {
  const data=canonicalJson({...object(body),mode:MODE,fixtureLabel:provider.label});
  if(Buffer.byteLength(data)>LIMITS.responseBytes) throw new Error('RESPONSE_CAP_503');
  return new Response(data,{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-paypal-mode':provider.mode,...extra}});
}
function stored(value:StoredResponse):Response {return response(JSON.parse(value.body),value.status);}
function errorResponse(error:unknown):Response {
  const message=error instanceof Error?error.message:'';
  const known=PUBLIC_ERRORS.has(message)?message:'REQUEST_FAILED';
  const status=known==='REQUEST_FAILED'?500:known.endsWith('_410')?410:known.endsWith('_413')?413:known.endsWith('_431')?431:known.endsWith('_415')?415:known.endsWith('_429')?429:known.endsWith('_504')?504:known.endsWith('_503')||/BUSY|CAP|FIXTURE_MISS/.test(known)?503:known.endsWith('_400')?400:/FORBIDDEN|ORIGIN|CSRF|SESSION|OWNER_MISMATCH/.test(known)?403:/NOT_FOUND/.test(known)?404:/INVALID|SCHEMA|POLICY_|UUID|SENSITIVE|REFUND_EXCEEDS|_422$/.test(known)?422:409;
  return response({error:known},status);
}

  bindLedgerMode(db,provider.mode,provider.merchantId);
  const service=new LedgerService(db,enforcementCatalogue,categoryMap,{clock,wait:async ms=>{await delay(ms);failures.assertWritable();if(ownership.closing)throw new Error('SERVER_STOPPING_503');}},provider.merchantId);
  const dispatcher=new FixtureDispatcher(db,provider,clock,failures),recovery=new FixtureRecovery(db,dispatcher,ownerId,clock,failures);
  const inbox=new FixtureWebhookInbox(db,ownerId,options.webhookVerifier);
  const app=new Hono();let commands=0;
  const current=()=>{const p=latestPolicy(db,ownerId);if(!p)throw new Error('MANDATE_NOT_FOUND');return p;};
  const currentBudget=()=>{const key=weeklyPeriod(serverNow(clock)).periodKey;return one(db,'SELECT 1 FROM budget_buckets WHERE owner_id=? AND period_key=?',ownerId,key)?budget(db,ownerId,key):null;};
  const owned=(id:string)=>{const r=reservation(db,resourceId(id));if(r.ownerId!==ownerId)throw new Error('OWNER_MISMATCH');return r;};
  const opOwned=(id:string)=>{const op=operation(db,resourceId(id));owned(op.kind==='REFUND_CREATE'?refund(db,op.subjectId).reservationId:op.subjectId);return op;};
  const local=async(ctx:CommandContext,route:string,subject:string,input:unknown,effect:()=>unknown,status=200)=>stored(await withImmediate(db,()=>{
    failures.assertWritable();
    if(serverNow(clock)>=ctx.session.expiresAt || clock.monotonicNow()>=ctx.session.deadlineMono)throw new Error('SESSION_EXPIRED');
    return localEffect(db,idempotencyScope(ownerId,'POST',route,subject),ctx.key,input,serverNow(clock),()=>({status,body:effect(),effectId:null}));
  },{clock,parentDeadlineMono:ctx.session.deadlineMono}));
  const modelEffect=async(ctx:CommandContext,route:string,input:unknown,signal:AbortSignal,prepare:()=>{context:Record<string,unknown>;finish:(output:unknown,model:string)=>unknown},value:string)=>{
    const leaseScope=idempotencyScope(ownerId,'POST',route,'owner');
    const tx=<T>(fn:()=>T)=>withImmediate(db,fn,{clock,parentDeadlineMono:ctx.session.deadlineMono});
    const claim=await tx(()=>{
      failures.assertWritable();
      const row=one(db,'SELECT state FROM idempotency_keys WHERE scope=? AND key=?',leaseScope,ctx.key);
      if(row && text(row,'state')!=='IN_PROGRESS')return {replay:localEffect(db,leaseScope,ctx.key,input,serverNow(clock),()=>{throw new Error('UNREACHABLE');})};
      const token=claimLease(db,leaseScope,ctx.key,input,clock),snapshot=hashJson(latestPolicy(db,ownerId));
      return {token,snapshot,prepared:prepare()};
    });
    if('replay' in claim)return stored(claim.replay!);
    let body:unknown,status=200;
    try {
      const result=await infer(options.llm!,route==='mandates/compile'?'compile':'agent',value,claim.prepared!.context,signal,ctx.session.deadlineMono-clock.monotonicNow()-500,options.modelText);
      if(result.kind!=='tool_call')throw new Error(result.kind==='timeout'?'MODEL_TIMEOUT_504':result.kind==='quota_error'?'MODEL_QUOTA_429':result.kind==='auth_error'?'MODEL_AUTH_503':'MODEL_UNAVAILABLE_503');
      body=await tx(()=>{
        failures.assertWritable();
        if(signal.aborted || serverNow(clock)>=ctx.session.expiresAt || clock.monotonicNow()>=ctx.session.deadlineMono)throw new Error('REQUEST_DEADLINE_504');
        if(hashJson(latestPolicy(db,ownerId))!==claim.snapshot)throw new Error('STALE_MODEL_CONTEXT_409');
        const resultBody={...object(claim.prepared!.finish(result.arguments,result.model.returned!)),modelProvenance:{mode:options.llm!.mode,provider:options.llm!.mode==='hosted'?'groq':'local',model:result.model.returned,identity:'returned',...(options.llm!.mode==='local'&&options.llm!.native?{digest:options.llm!.digest}:{})}};
        finishLease(db,leaseScope,ctx.key,claim.token!,resultBody,clock);
        return resultBody;
      });
      return response(body);
    } catch(error) {
      const publicResponse=errorResponse(error);status=publicResponse.status;
      body={error:(await publicResponse.json() as {error:string}).error};
    }
    // A host/event-loop suspension can exhaust the route budget before the
    // adapter returns. Do not mask its failure with an expired cleanup transaction
    // (withImmediate reports DB_BUSY before BEGIN in that case). Leave the lease
    // untouched: no late success is accepted, and existing lease recovery applies.
    if(signal.aborted || clock.monotonicNow()>=ctx.session.deadlineMono || serverNow(clock)>=ctx.session.expiresAt)return response(body,status);
    // Within the original budget, persist failures so the same key replays.
    await tx(()=>finishLease(db,leaseScope,ctx.key,claim.token!,body,clock,status));
    return response(body,status);
  };
  const handle=async(req:Request,signal:AbortSignal):Promise<Response>=>{
    const url=new URL(req.url),path=url.pathname,method=req.method;
    let scope:ReturnType<typeof deadlineScope>|undefined,admitted=false;
    try {
      // Cross-site top-level PayPal navigation has no Strict session cookie.
      // Only these GET callbacks bypass Origin/Fetch-Site; HMAC state binds the
      // reservation and token is checked against its persisted order. No capture.
      if(method==='GET' && provider.mode==='sandbox' && ['/api/paypal/return','/api/paypal/cancel'].includes(path)) {
        if(req.headers.get('host')!==session.host)throw new Error('HOST_FORBIDDEN_403');
        if(['reservation','token','state'].some(k=>url.searchParams.getAll(k).length!==1))throw new Error('RETURN_STATE_FORBIDDEN_403');
        const id=resourceId(url.searchParams.get('reservation')),token=resourceId(url.searchParams.get('token'));
        const r=owned(id);
        if(r.orderId!==token || !session.verifyReturn(id,id,url.searchParams.get('state')??''))throw new Error('RETURN_STATE_FORBIDDEN_403');
        const owner=session.callbackSession(req);
        if(!owner) {
          const title=path==='/api/paypal/cancel'?'PayPal cancellation':'PayPal approval';
          const message=path==='/api/paypal/cancel'?'Checkout cancelled at PayPal — return to the app tab.':'Approval received by PayPal — return to the app tab to continue.';
          return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><p>${message}</p></html>`,{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'referrer-policy':'no-referrer'}});
        }
        const check=deadlineScope(signal,owner.deadlineMono,clock);
        try {
          if(r.capturedMinor===0){
            let attempted=false;
            const order=await provider.get('order',token,{...check,getPurpose:'callback',beforeGet:async()=>{
              // One wire GET per navigation, including a potential 401 replay.
              if(attempted)throw new Error('CALLBACK_GET_LIMIT');attempted=true;
            }});
            if(path==='/api/paypal/return' && !['APPROVED','COMPLETED'].includes(order.status))throw new Error('BAD_STATE');
          }
        } catch(error) {
          // Callback reads are advisory; cart refresh remains authoritative.
          if(!(error instanceof Error) || !['GET_RESOURCE_BUDGET_EXHAUSTED','CALLBACK_GET_LIMIT'].includes(error.message))throw error;
        } finally {check.close();}
        return response({reservationId:id,cancelled:path.endsWith('cancel'),reconcileRequired:true},303,{location:`/cart?r=${id}&mode=sandbox&checkout=${path.endsWith('cancel')?'cancelled':'returned'}`});
      }
      session.boundary(req);
      if(ownership.closing) throw new Error('SERVER_STOPPING_503');
      failures.assertWritable();assertDeadline({signal,monotonicEndsAt:Infinity},clock);
      if(method==='GET' && path==='/api/health') return response({version:'0.0.0',catalogueHash:hashJson({catalogue,categoryMap}),now:serverNow(clock),startupRecovery:recovery.state,merchantId:provider.merchantId});
      if(method==='GET' && path==='/api/session') {
        const bootstrap=session.bootstrap(req);return response({csrfNonce:bootstrap.csrfNonce,expiresAt:bootstrap.expiresAt},200,{'set-cookie':bootstrap.cookie});
      }
      if(method==='POST' && ['/api/webhooks/paypal','/api/fixtures/webhooks'].includes(path)) {
        scope=deadlineScope(signal,clock.monotonicNow()+LIMITS.mutationMs,clock);
        const raw=await readBody(req,scope,LIMITS.webhookBodyBytes,clock,bodyControl);
        // receive resolves only after the delivery transaction commits. Storage
        // failures must reach the existing error path before any 400/200 reply.
        const {malformed,...delivery}=await inbox.receive(raw,req.headers,serverNow(clock),path==='/api/fixtures/webhooks' && provider.mode==='fixture');
        return response(delivery,malformed?400:200);
      }
      const mutation=method==='POST',duration=(options.llm && (path==='/api/mandates/compile'||path==='/api/agent/propose'))?60000:path==='/api/reconcile'||/^\/api\/operations\/[^/]+\/dispatch$/.test(path)?LIMITS.post.sessionMs:LIMITS.mutationMs;
      const auth=session.authorize(req,mutation,duration);
      scope=deadlineScope(signal,auth.deadlineMono,clock);
      if(method==='GET') {
        if(path==='/api/catalogue') return response({merchantId:provider.merchantId,items:catalogue.map(item=>({...item,categoryId:categoryMap[item.sku]}))});
        if(path==='/api/mandates/current') return response({policy:current(),budget:currentBudget()});
        let m=/^\/api\/reservations\/([^/]+)$/.exec(path);
        if(m) {
          const r=owned(m[1]!);
          const ops=all(db,"SELECT id FROM operations WHERE subject_id=? OR subject_id IN(SELECT id FROM refunds WHERE reservation_id=?) ORDER BY created_at LIMIT 100",r.id,r.id).map(row=>{const op=operation(db,text(row,'id'));const {ownerToken:_token,...publicOp}=op;return publicOp;});
          let approveUrl:string|null=null,reconciliationError:string|null=null;
          try {approveUrl=provider.mode==='sandbox'?(r.orderId?((await provider.get('order',r.orderId,scope)) as import('./paypal/provider.ts').OrderResource).approvalUrl??null:null):r.orderId?`${session.origin}/api/fixtures/approval?token=${encodeURIComponent(r.orderId)}&state=${session.returnState(r.id,r.orderId)}`:null;}
          catch {reconciliationError='PROVIDER_RECONCILIATION_UNAVAILABLE_OR_UNSUPPORTED';}
          return response({reservation:r,operations:ops,refunds:all(db,'SELECT id FROM refunds WHERE reservation_id=? ORDER BY created_at LIMIT 100',r.id).map(row=>refund(db,text(row,'id'))),approveUrl,reconciliationError});
        }
        m=/^\/api\/operations\/([^/]+)$/.exec(path);
        if(m) {const {ownerToken:_token,...publicOp}=opOwned(m[1]!);return response({operation:publicOp});}
        if(path==='/api/ledger') {
          const since=url.searchParams.get('since')??'0';if(!/^\d{1,12}$/.test(since))throw new Error('REQUEST_SCHEMA_422');
          const rows=all(db,'SELECT * FROM ledger_rows WHERE owner_id=? AND seq>? ORDER BY seq LIMIT 100',ownerId,Number(since)).map(row=>({seq:int(row,'seq'),at:int(row,'at'),ownerId:text(row,'owner_id'),mandateId:text(row,'mandate_id'),policyVersion:int(row,'policy_version'),periodKey:text(row,'period_key'),kind:text(row,'kind'),reservationId:row['reservation_id'],amountMinor:int(row,'amount_minor'),availableAfter:int(row,'available_after'),reservedAfter:int(row,'reserved_after'),capturedAfter:int(row,'captured_after'),restoredAfter:int(row,'restored_after'),refundedCompletedAfter:int(row,'refunded_completed_after'),ruleIds:json(row,'rule_ids'),paypal:json(row,'paypal'),source:text(row,'source'),note:text(row,'note')}));
          return response({rows,totals:currentBudget(),nextSince:rows.at(-1)?.seq??Number(since)});
        }
        if(provider.mode==='fixture' && (path==='/api/fixtures/approval'||path==='/api/paypal/return')) {
          const token=resourceId(url.searchParams.get('token')),state=url.searchParams.get('state')??'';
          const found=one(db,'SELECT id FROM reservations WHERE owner_id=? AND order_id=?',ownerId,token);if(!found)throw new Error('ORDER_NOT_FOUND');
          const id=text(found,'id');if(!session.verifyReturn(id,token,state))throw new Error('RETURN_STATE_FORBIDDEN_403');
          if(path==='/api/paypal/return') {
            const op=one(db,"SELECT id FROM operations WHERE subject_id=? AND kind IN('ORDER_CREATE','ORDER_CAPTURE') ORDER BY kind DESC LIMIT 1",id);
            if(op)await recovery.enqueue(text(op,'id'));
            return response({reservationId:id,approval:'SIMULATED PAYPAL APPROVAL'},303,{location:`/cart?r=${id}&mode=fixture`});
          }
          // Fixture approval GET is informational, and cannot approve or capture.
          return response({reservationId:id,approval:'SIMULATED PAYPAL APPROVAL',next:`POST /api/reservations/${id}/simulate-approval`,consolePath:`/cart?r=${id}`,reconcileRequired:true});
        }
        return response({error:'NOT_FOUND'},404);
      }
      if(!mutation) return response({error:'METHOD_NOT_ALLOWED'},405);
      if(commands>=LIMITS.queue) throw new Error('COMMAND_QUEUE_FULL_503');commands++;admitted=true;
      const input=await readJson(req,scope,clock,bodyControl);assertDeadline(scope,clock);failures.assertWritable();
      const ctx:CommandContext={ownerId,key:req.headers.get('idempotency-key')!,session:auth};
      let m:RegExpExecArray|null;
      if(path==='/api/mandates/compile') {
        const b=fields(input,['text'],['text']),value=string(b['text'],LIMITS.compile.textChars);
        if(options.llm)return await modelEffect(ctx,'mandates/compile',b,scope.signal,()=>{
          const prior=latestPolicy(db,ownerId),now=serverNow(clock),base={...safeDefaults(ownerId,prior?.mandateId??randomUUID(),now),merchantId:provider.merchantId,version:(prior?.version??0)+1,sourceText:value,compiledBy:compilerFor(options.llm!)};
          return {context:{defaults:base,now:new Date(now).toISOString(),...base},finish:(output,model)=>{
            if(options.llm!.mode==='local'&&options.llm!.native){
              const draft=buildDraftPolicy(output,{ownerId,mandateId:base.mandateId,merchantId:provider.merchantId,version:base.version,ownerText:value,now});
              return {draft,diff:reviewDiff(base,draft),warnings:['Local AI extracts four USD limits and allowed/denied categories only. Expiry, quantity/cart limits and refund rules use server defaults. Other requested clauses are not inferred. Review every field before signing.'],compiledBy:draft.compiledBy};
            }
            const candidate=object(output);
            for(const field of ['ownerId','mandateId','version','merchantId','currency','period','compiledBy','sourceText','status','signedAt','contentHash'])if(canonicalJson(candidate[field])!==canonicalJson(base[field as keyof typeof base]))throw new Error('MODEL_OUTPUT_422');
            const draft=boundedDraft({...candidate,compiledBy:compilerFor(options.llm!,model)},base,now);
            return {draft,diff:reviewDiff(base,draft),warnings:['Live model candidate; limits capped at server defaults; owner review required'],compiledBy:draft.compiledBy};
          }};
        },value);
        return await local(ctx,'mandates/compile' ,'owner',b,()=>{
          const result=fixtureLookup([compilerFixture as FixtureRecord<MandatePolicy>],value);
          const draft=boundedDraft({...result.output,ownerId},safeDefaults(ownerId,result.output.mandateId,serverNow(clock)),serverNow(clock));
          return {draft,diff:reviewDiff(safeDefaults(ownerId,draft.mandateId,serverNow(clock)),draft),warnings:['Handwritten fixture output; no model call; quantity capped at server default 5'],compiledBy:draft.compiledBy};
        });
      }
      if((m=/^\/api\/mandates\/([^/]+)\/sign$/.exec(path))) {
        const b=fields(input,['draft','expectedCurrentHash','confirm','explicitlyAllowedSensitive'],['draft','expectedCurrentHash','confirm']);
        const draft=object(b['draft']);if(draft['merchantId']!==provider.merchantId)throw new Error('REQUEST_SCHEMA_422');if(draft['mandateId']!==resourceId(m[1]))throw new Error('MANDATE_ID_INVALID');
        if(b['confirm']!==true || !(b['expectedCurrentHash']===null || typeof b['expectedCurrentHash']==='string'))throw new Error('REQUEST_SCHEMA_422');
        return stored(await service.sign(ctx,draft,{confirm:true,expectedCurrentHash:b['expectedCurrentHash'],explicitlyAllowedSensitive:(b['explicitlyAllowedSensitive']??[]) as readonly ('gift_cards'|'alcohol')[]}));
      }
      if((m=/^\/api\/mandates\/([^/]+)\/revoke$/.exec(path))) {empty(input);return stored(await service.revoke(ctx,resourceId(m[1])));}
      if(path==='/api/agent/propose') {
        const b=fields(input,['request'],['request']),value=string(b['request'],LIMITS.agent.requestChars);
        if(options.llm)return await modelEffect(ctx,'agent/propose',b,scope.signal,()=>{
          const p=current(),source={kind:'agent' as const,mode:options.llm!.mode,model:options.llm!.model},proposalId=randomUUID();
          return {context:{policy:p,proposalId,mandateId:p.mandateId,source,budget:currentBudget(),now:new Date(serverNow(clock)).toISOString()},finish:(output,model)=>{
            const proposal=options.llm!.mode==='local'&&options.llm!.native?buildCartProposal(output,{proposalId,mandateId:p.mandateId}):proposalSchema.parse(output);
            if(proposal.proposalId!==proposalId || proposal.mandateId!==p.mandateId || canonicalJson(proposal.source)!==canonicalJson(source))throw new Error('MODEL_OUTPUT_422');
            const budget=currentBudget();if(!budget)throw new Error('BUCKET_NOT_FOUND');
            return {proposal:{...proposal,source:{...source,model}},rationale:'Live model proposal (display only)',verdict:evaluateCart(current(),enforcementCatalogue,categoryMap,proposal,budget,serverNow(clock),false,provider.merchantId)};
          }};
        },value);
        return await local(ctx,'agent/propose' ,'owner',b,()=>{
          const p=current(),result=fixtureLookup([restockFixture,confusedFixture] as FixtureRecord<CartProposal>[],value),proposal=proposalSchema.parse({...result.output,mandateId:p.mandateId});
          const budget=currentBudget();if(!budget)throw new Error('BUCKET_NOT_FOUND');
          return {proposal,rationale:'Handwritten fixture proposal (display only)',verdict:evaluateCart(p,enforcementCatalogue,categoryMap,proposal,budget,serverNow(clock),false,provider.merchantId)};
        });
      }
      if(path==='/api/carts/evaluate') {
        const b=fields(input,['proposal'],['proposal']);return await local(ctx,'carts/evaluate','owner',b,()=>{const budget=currentBudget();if(!budget)throw new Error('BUCKET_NOT_FOUND');return {verdict:evaluateCart(current(),enforcementCatalogue,categoryMap,b['proposal'],budget,serverNow(clock),false,provider.merchantId)};});
      }
      if(path==='/api/carts/reserve') {
        if(recovery.state!=='done')throw new Error('STARTING_503');
        const b=fields(input,['proposal','expectedPolicyHash','stepUpConfirmed'],['proposal','expectedPolicyHash']);
        if(b['stepUpConfirmed']!==undefined && b['stepUpConfirmed']!==true)throw new Error('REQUEST_SCHEMA_422');
        return stored(await service.reserve(ctx,proposalSchema.parse(b['proposal']),string(b['expectedPolicyHash'],64),b['stepUpConfirmed']===true));
      }
      if((m=/^\/api\/reservations\/([^/]+)\/(checkout|capture|cancel|simulate-approval|disposition)$/.exec(path))) {
        const r=owned(m[1]!),action=m[2];
        if(action==='disposition') {
          const b=fields(input,['action','confirm'],['action','confirm']);if(b['action']!=='acknowledge_anomaly'||b['confirm']!==true)throw new Error('DISPOSITION_NOT_IMPLEMENTED_422');
          // Metadata acknowledgement cannot release holds or clear a block.
          return await local(ctx,'reservations/disposition',r.id,b,()=>{audit(db,r,'DISPOSITION',0,serverNow(clock),'Acknowledged; unresolved money and owner block retained');return {acknowledged:true,unresolvedMoneyRetained:true};});
        }
        empty(input);
        if(action==='cancel')return stored(await service.cancel(ctx,r.id));
        if(action==='simulate-approval') {
          if(provider.mode!=='fixture' || !provider.approve || !r.orderId)throw new Error('BAD_STATE');
          const result=await local(ctx,'reservations/simulate-approval',r.id,{},()=>({reservationId:r.id,approval:'SIMULATED PAYPAL APPROVAL',reconcileRequired:true}));
          provider.approve(r.orderId);return result;
        }
        if(recovery.state!=='done')throw new Error('STARTING_503');
        return stored(await service.preparePurchase(ctx,r.id,action==='checkout'?'ORDER_CREATE':'ORDER_CAPTURE',action==='checkout'?createOrderBody(db,r.id,provider.merchantId,provider.mode==='sandbox'?{returnUrl:`${session.origin}/api/paypal/return?reservation=${r.id}&state=${session.returnState(r.id,r.id)}`,cancelUrl:`${session.origin}/api/paypal/cancel?reservation=${r.id}&state=${session.returnState(r.id,r.id)}`}:undefined):{}));
      }
      if((m=/^\/api\/captures\/([^/]+)\/refunds$/.exec(path))) {
        const b=fields(input,['amountMinor','reason'],['reason']);
        // S1 refunds hash amount only. Restrict reason to one literal until a reviewed
        // S1 extension can bind arbitrary reasons into that transaction's key hash.
        if(b['reason']!=='requested_by_owner'||b['amountMinor']!==undefined && (typeof b['amountMinor']!=='number'||!Number.isSafeInteger(b['amountMinor'])))throw new Error('REQUEST_SCHEMA_422');
        return stored(await service.requestRefund(ctx,resourceId(m[1]),b['amountMinor'] as number|undefined));
      }
      if((m=/^\/api\/operations\/([^/]+)\/dispatch$/.exec(path))) {
        empty(input);const op=opOwned(m[1]!);
        const result=await local(ctx,'operations/dispatch',op.id,{},()=>({operationId:op.id}),202);
        try {await dispatcher.dispatch(op.id,auth,scope);} catch(error) {
          failures.observe(error);failures.assertWritable();
          await withImmediate(db,()=>{failures.assertWritable();return run(db,"UPDATE operations SET last_error='provider dispatch preflight deferred; no new send claim' WHERE id=? AND state='READY' AND attempt=0",op.id);},{clock});
        }
        return result;
      }
      if(path==='/api/reconcile') {
        const b=fields(input,['scope'],['scope']);let id:string|undefined;
        if(b['scope']!=='all') {const target=fields(b['scope'],['reservationId'],['reservationId']);id=owned(string(target['reservationId'],128)).id;}
        const scopeKey=id??'all';
        const keyScope=idempotencyScope(ownerId,'POST','reconcile',scopeKey);
        const admission=await withImmediate(db,()=>{
          failures.assertWritable();
          const prior=one(db,'SELECT * FROM idempotency_keys WHERE scope=? AND key=?',keyScope,ctx.key);
          if(prior && text(prior,'state')!=='IN_PROGRESS') return {response:localEffect(db,keyScope,ctx.key,b,serverNow(clock),()=>{throw new Error('UNREACHABLE');})};
          return {token:claimLease(db,keyScope,ctx.key,b,clock)};
        },{clock,parentDeadlineMono:scope.monotonicEndsAt});
        if(admission.response)return stored(admission.response);
        let result:Response;
        try {result=response(await recovery.run(scope,'manual',id));} catch(error) {failures.observe(error);failures.assertWritable();result=errorResponse(error);}
        const body=await result.text();
        await withImmediate(db,()=>{
          failures.assertWritable();
          finishLease(db,keyScope,ctx.key,admission.token!,JSON.parse(body),clock);
          run(db,'UPDATE idempotency_keys SET response_status=? WHERE scope=? AND key=? AND owner_token=?',result.status,keyScope,ctx.key,admission.token!);
        },{clock,parentDeadlineMono:scope.monotonicEndsAt});
        return new Response(body,{status:result.status,headers:result.headers});
      }
      return response({error:'NOT_FOUND'},404);
    } catch(error) {failures.observe(error);return errorResponse(failures.reason?new Error(failures.reason):error);}
    finally {scope?.close();if(admitted)commands--;}
  };
  app.all('*',async c=>{
    // Track every admitted route, including body reads, webhooks and GET return work.
    try {return await ownership.run(c.req.raw.signal,signal=>handle(c.req.raw,signal));}
    catch(error){failures.observe(error);return errorResponse(failures.reason?new Error(failures.reason):error);}
  });
  return {app,session,provider,dispatcher,recovery,failures,ownership,startup:(parent:AbortSignal)=>ownership.run(parent,async signal=>{
    const scope=deadlineScope(signal,clock.monotonicNow()+LIMITS.recovery.startupMs,clock);
    try {return await recovery.run(scope,'startup');}finally {scope.close();}
  }),stopAdmission:()=>ownership.stopAdmission(),shutdown:(endsAt?:number)=>ownership.drain(endsAt)};
}

// Mode-neutral entrypoint; legacy fixture name retained for existing callers.
export const createApp=createFixtureApp;
export type AppOptions=FixtureAppOptions;
