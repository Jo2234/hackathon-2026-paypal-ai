import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SandboxPayPal } from '../../src/server/paypal/client.ts';
import type { TransportEvidence } from '../../src/server/paypal/client.ts';
import { SANDBOX_BASE } from '../../src/server/env.ts';
const servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
const merchant='SELLER123';
const money={currency_code:'USD',value:'10.00'};
const capture=(status='COMPLETED')=>({id:'CAP123',status,amount:money,payee:{merchant_id:merchant},supplementary_data:{related_ids:{order_id:'ORDER123'}}});
const order=(status='CREATED',captures=false)=>({id:'ORDER123',status,purchase_units:[{custom_id:'RES123',invoice_id:'RES123',payee:{merchant_id:merchant},amount:money,...(captures?{payments:{captures:[{id:'CAP123',status:'COMPLETED',amount:money}]}}:{})}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123'}]});
type RequestLog={path:string;method:string;requestId:string|undefined;body:string;auth:string|undefined};
async function fixture(handler:(req:RequestLog,n:number)=>{status?:number;body:unknown;delay?:boolean}, now=()=>performance.now()) {
 const requests:RequestLog[]=[],evidence:TransportEvidence[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const entry={path:req.url!,method:req.method!,requestId:req.headers['paypal-request-id'] as string|undefined,body,auth:req.headers.authorization};requests.push(entry);const reply=handler(entry,requests.length);if(reply.delay)return;res.writeHead(reply.status??200,{'content-type':'application/json','paypal-debug-id':'DEBUG123'});res.end(typeof reply.body==='string'?reply.body:JSON.stringify(reply.body));});
 servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address() as {port:number};
 // The production client still constructs sandbox-only URLs. Test adapter alone
 // routes their path to this ephemeral local HTTP server.
 const transport:typeof fetch=(input,init)=>{const u=new URL(String(input));expect(u.origin).toBe(SANDBOX_BASE);return fetch(`http://127.0.0.1:${addr.port}${u.pathname}`,init);};
 const client=new SandboxPayPal({clientId:'offline',clientSecret:'offline',merchantId:merchant},transport,e=>evidence.push(e),now);
 return {client,requests,evidence,transport};
}
const deadline=()=>({signal:new AbortController().signal,monotonicEndsAt:performance.now()+2000});
const command=()=>({kind:'ORDER_CREATE' as const,resourceId:null,requestId:randomUUID(),canonicalBody:'{}'});
const token={access_token:'offline',token_type:'Bearer',expires_in:3600};
import { openDb } from '../../src/server/db/db.ts';
import { budget, reservation, operation } from '../../src/server/db/repo.ts';
import { LedgerService } from '../../src/domain/ledger/service.ts';
import { safeDefaults } from '../../src/domain/policy/policy.ts';
import { categoryMap, enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { weeklyPeriod } from '../../src/domain/ledger/period.ts';
import { assertLedgerInvariants } from '../../src/domain/ledger/invariants.ts';
async function ledger(path=':memory:') {
 const db=openDb(path),now=Date.now();
 const service=new LedgerService(db,enforcementCatalogue,categoryMap,{},merchant);
 const context=()=>({ownerId:'owner',key:randomUUID(),session:{expiresAt:Date.now()+3600000,deadlineMono:performance.now()+60000}});
 const draft={...safeDefaults('owner','mandate',now),merchantId:merchant,allowanceMinor:4000,perOrderMaxMinor:4000};
 const signed=JSON.parse((await service.sign(context(),draft,{confirm:true,expectedCurrentHash:null,explicitlyAllowedSensitive:[]})).body).policy;
 const reserve=()=>service.reserve(context(),{proposalId:randomUUID(),mandateId:'mandate',lines:[{sku:'COF-001',qty:2},{sku:'PRT-004',qty:1}],source:{kind:'owner'}},signed.contentHash,true);
 return {db,service,context,reserve,signed,period:weeklyPeriod(now).periodKey};
}
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all } from '../../src/server/db/repo.ts';
import { createFixtureApp } from '../../src/server/app.ts';
it('F2 capture, partial refund, GET, full refund and disk reload preserve gross and exact refund totals',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paypal-refund-')),path=join(dir,'ledger.sqlite');
 const s=await ledger(path);let runtime:ReturnType<typeof createFixtureApp>|undefined;
 try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 let stage='create',refundNumber=0,unsupported=false;
 const f=await fixture(req=>{
 if(req.path.includes('oauth2'))return {body:token};
 if(req.path.includes('/refunds/'))return {body:{id:req.path.split('/').at(-1),status:'COMPLETED',amount:{currency_code:'USD',value:req.path.endsWith('REF1')?'10.00':'29.99'},links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]}};
 if(req.path.endsWith('/refund'))return {body:{id:`REF${++refundNumber}`,status:'COMPLETED',links:[{rel:'up',href:'https://api.sandbox.paypal.com/v2/payments/captures/CAP123'}]}};
 if(req.path.includes('/captures/'))return {body:{...capture(stage==='partial'?'PARTIALLY_REFUNDED':stage==='full'?'REFUNDED':'COMPLETED'),amount:{currency_code:'USD',value:'39.99'}}};
 const o=order(stage==='create'?'CREATED':stage==='approved'?'APPROVED':'COMPLETED',!['create','approved'].includes(stage));
 o.purchase_units[0]!.custom_id=r.id;o.purchase_units[0]!.invoice_id=r.id;o.purchase_units[0]!.amount={currency_code:'USD',value:'39.99'};
 if(unsupported)return {status:503,body:{}};
 return {body:o};
 });
 runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client});await runtime.startup(new AbortController().signal);
 const dispatch=async(id:string)=>runtime!.dispatcher.dispatch(id,s.context().session,deadline());
 const create=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);await dispatch(create.operationId);
 stage='approved';await runtime.dispatcher.apply(operation(s.db,create.operationId),await f.client.get('order','ORDER123',deadline()));
 const cap=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CAPTURE',{})).body);
 // Preflight must still be APPROVED; only POST changes the simulated provider state.
 const originalPost=f.client.post.bind(f.client);
 f.client.post=async(cmd,dl)=>{if(cmd.kind==='ORDER_CAPTURE')stage='captured';return originalPost(cmd,dl);};
 await dispatch(cap.operationId);expect(reservation(s.db,r.id).capturedMinor).toBe(3999);
 const refundPart=async(amount:number)=>{const op=JSON.parse((await s.service.requestRefund(s.context(),'CAP123',amount)).body);await dispatch(op.operationId);expect(operation(s.db,op.operationId).state).toBe('DONE');const current=operation(s.db,op.operationId);const resource=await f.client.get('refund',`REF${refundNumber}`,deadline());await runtime!.dispatcher.apply(current,resource);await runtime!.dispatcher.apply(current,resource);};
 await refundPart(1000);stage='partial';
 await runtime.dispatcher.apply(operation(s.db,cap.operationId),await f.client.get('order','ORDER123',deadline()));
 expect(reservation(s.db,r.id).capturedMinor).toBe(3999);expect(budget(s.db,'owner',s.period).refundedCompletedMinor).toBe(1000);
 await refundPart(2999);stage='full';
 await runtime.dispatcher.apply(operation(s.db,cap.operationId),await f.client.get('order','ORDER123',deadline()));
 await runtime.shutdown();runtime=undefined;s.db.close();s.db=openDb(path);
 runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client});await runtime.startup(new AbortController().signal);
 const host='127.0.0.1:8787';const bootstrap=await runtime.app.request(new Request(`http://${host}/api/session`,{headers:{host,origin:`http://${host}`}}));const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0]!;
 const read=async()=>runtime!.app.request(new Request(`http://${host}/api/reservations/${r.id}`,{headers:{host,cookie}}));
 const loaded=await read();expect(loaded.status).toBe(200);const view=await loaded.json();expect(view.reservation.capturedMinor).toBe(3999);expect(budget(s.db,'owner',s.period).refundedCompletedMinor).toBe(3999);expect(view.refunds).toHaveLength(2);
 unsupported=true;const failed=await read();expect(failed.status).toBe(200);const history=await failed.json();expect(history.reconciliationError).toBeTruthy();expect(history.refunds).toHaveLength(2);
 expect(all(s.db,"SELECT * FROM ledger_rows WHERE kind='CAPTURE'")).toHaveLength(1);assertLedgerInvariants(s.db);
 }finally{if(runtime)await runtime.shutdown();s.db.close();rmSync(dir,{recursive:true});}
});
// Constructed Payments v2 responses, not a retained live response body.
// https://developer.paypal.com/api/payments/v2/captures-refund (minimal/representation)
// https://developer.paypal.com/api/rest/webhooks/rest/ (sandbox HATEOAS host alias)
const refundShape=(origin:string,minimal=false)=>({id:'72M812978C4211943',status:'COMPLETED',...(!minimal?{amount:{currency_code:'USD',value:'1.00'}}:{}),links:[{rel:'self',method:'GET',href:origin+'/v2/payments/refunds/72M812978C4211943'},{rel:'up',method:'GET',href:origin+'/v2/payments/captures/7GE02798JV342053M'}]});
it.each([['https://api.sandbox.paypal.com',false],[SANDBOX_BASE,true],['https://api.sandbox.paypal.com',true]])('refund real-shape %s minimal=%s persists identity before enrichment',async(origin,minimal)=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:refundShape(origin,req.method==='POST'&&minimal)}));
 const events:string[]=[];f.client.bindGetAdmission(async path=>{events.push(path);});
 const result=await f.client.post({kind:'REFUND_CREATE',resourceId:'7GE02798JV342053M',requestId:randomUUID(),canonicalBody:JSON.stringify({amount:{currency_code:'USD',value:'1.00'}})},{...deadline(),onResourceId:async id=>{events.push(id);}});
 expect(result).toMatchObject({id:'72M812978C4211943',amount:{value:'1.00'},supplementary_data:{related_ids:{capture_id:'7GE02798JV342053M'}}});
 expect(events[0]).toBe('72M812978C4211943');
 expect(f.requests.filter(r=>r.method==='POST'&&!r.path.includes('oauth2'))).toHaveLength(1);
 if(minimal)expect(events[1]).toBe('/v2/payments/refunds/72M812978C4211943');
 await expect(f.client.get('refund','72M812978C4211943',deadline())).resolves.toMatchObject({status:'COMPLETED'});
});
it.each(['https://example.com','http://api.sandbox.paypal.com','https://api.sandbox.paypal.com.evil.test','https://user@api.sandbox.paypal.com'])('refund rejects hostile parent %s without following it',async origin=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:refundShape(origin)}));
 await expect(f.client.get('refund','72M812978C4211943',deadline())).rejects.toThrow('PAYPAL_REFUND_PARENT_INVALID');
 expect(f.requests).toHaveLength(2);
});
it('minimal capture order response enriches through canonical order and capture GET',async()=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:req.method==='POST'?{id:'ORDER123',status:'COMPLETED',links:[]}:req.path.includes('/captures/')?capture():order('COMPLETED',true)}));
 await expect(f.client.post({...command(),kind:'ORDER_CAPTURE',resourceId:'ORDER123'},deadline())).resolves.toMatchObject({status:'COMPLETED'});
 expect(f.requests.filter(r=>r.method==='GET').map(r=>r.path)).toEqual(['/v2/checkout/orders/ORDER123','/v2/payments/captures/CAP123']);
});

import { acceptanceStep, sanitizedAcceptanceError, assertRefundCorrelation } from '../../src/server/paypal/client.ts';
it.each(['approve-check','capture','capture-settle','refund','refund-get'])('acceptance evidence durably identifies failed %s without exception contents',async failing=>{
 const report:Parameters<typeof acceptanceStep>[0]={steps:[]};const snapshots:string[]=[];
 const save=()=>{snapshots.push(JSON.stringify(report));};
 const privateError=new TypeError('raw-provider-body-and-private-token');
 for(const name of ['create','approve-check','capture','capture-settle','refund','refund-get']){
  if(name===failing){await expect(acceptanceStep(report,save,name,async()=>{throw privateError;})).rejects.toBe(privateError);break;}
  await acceptanceStep(report,save,name,async()=>true);
 }
 expect(report.failure).toMatchObject({step:failing,error:{class:'TypeError',code:'UNCLASSIFIED_ERROR'}});
 expect(report.steps.at(-1)).toMatchObject({step:failing,status:'FAIL',failedAt:expect.any(String)});
 expect(report.steps.every(s=>s.startedAt)).toBe(true);
 expect(report.steps.slice(0,-1).every(s=>s.status==='PASS'&&s.completedAt)).toBe(true);
 expect(snapshots.join('')).not.toContain(privateError.message);
 expect(JSON.parse(snapshots.at(-2)!).steps.at(-1).status).toBe('RUNNING');
 expect(sanitizedAcceptanceError(new Error('PAYPAL_REFUND_PARENT_INVALID')).code).toBe('PAYPAL_REFUND_PARENT_INVALID');
});
it.each(['budget','deadline','unavailable'])('minimal refund %s failure retains locator and never repeats POST',async fault=>{
 const f=await fixture(req=>req.path.includes('oauth2')?{body:token}:req.method==='POST'?{body:refundShape(SANDBOX_BASE,true)}:{status:503,body:{}});
 let retained='';const dl=deadline();
 f.client.bindGetAdmission(async()=>{if(fault==='budget')throw new Error('GET_DURABLE_BUDGET');});
 await expect(f.client.post({kind:'REFUND_CREATE',resourceId:'7GE02798JV342053M',requestId:randomUUID(),canonicalBody:'{}'},{...dl,onResourceId:async id=>{retained=id;},beforeGet:async()=>{if(fault==='deadline')throw new Error('PROVIDER_DEADLINE');}})).rejects.toThrow();
 expect(retained).toBe('72M812978C4211943');expect(f.requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});

const refundCommand=()=>({kind:'REFUND_CREATE' as const,resourceId:'CAP123',requestId:randomUUID(),canonicalBody:JSON.stringify({amount:{currency_code:'USD',value:'1.00'}})});
const correlatedRefund=()=>({id:'REF123',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'},links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]});
const refundFault=(fault:string)=>{const value=correlatedRefund();if(fault==='parent')value.links[0]!.href=SANDBOX_BASE+'/v2/payments/captures/OTHER';if(fault==='amount')value.amount.value='99.00';if(fault==='currency')value.amount.currency_code='EUR';if(fault==='id')value.id='OTHER';if(fault==='pending')value.status='PENDING';return value;};
for(const minimal of [false,true])for(const fault of ['parent','amount','currency'])it(`refund correlation ${fault} minimal=${minimal} fails after retaining ID without resend`,async()=>{
 const events:string[]=[];const f=await fixture(req=>({body:req.path.includes('oauth2')?token:req.method==='POST'&&minimal?{id:'REF123',status:'COMPLETED'}:refundFault(fault)}));
 f.client.bindGetAdmission(async()=>{events.push('GET');});
 await expect(f.client.post(refundCommand(),{...deadline(),onResourceId:async id=>{events.push(id);}})).rejects.toThrow('PAYPAL_REFUND_CORRELATION_MISMATCH');
 expect(events[0]).toBe('REF123');expect(events).toHaveLength(minimal?2:1);expect(f.requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
 expect(sanitizedAcceptanceError(new Error('PAYPAL_REFUND_CORRELATION_MISMATCH'))).toEqual({class:'Error',code:'PAYPAL_REFUND_CORRELATION_MISMATCH'});
});
it('refund enrichment is one logical GET with two admitted 401 attempts and the original deadline',async()=>{
 let gets=0;const f=await fixture(req=>req.path.includes('oauth2')?{body:token}:req.method==='POST'?{body:{id:'REF123',status:'COMPLETED'}}:++gets===1?{status:401,body:{}}:{body:correlatedRefund()});
 const dl=deadline(),admissions:string[]=[],seen:unknown[]=[];f.client.bindGetAdmission(async(path,purpose)=>{admissions.push(path+':'+purpose);});
 const original=f.client.get.bind(f.client);f.client.get=async(kind,id,scope)=>{seen.push(scope);return original(kind,id,scope);};
 await f.client.post(refundCommand(),dl);
 expect(seen).toEqual([dl]);expect(seen[0]).toBe(dl);expect(admissions).toEqual(Array(2).fill('/v2/payments/refunds/REF123:foreground'));expect(gets).toBe(2);
 expect(f.requests.filter(r=>r.path.includes('oauth2'))).toHaveLength(2);expect(f.requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});
it('second enrichment wire attempt cannot bypass admission after 401',async()=>{
 let admitted=0;const f=await fixture(req=>req.path.includes('oauth2')?{body:token}:req.method==='POST'?{body:{id:'REF123'}}:{status:401,body:{}});
 f.client.bindGetAdmission(async()=>{if(++admitted===2)throw new Error('GET_DURABLE_BUDGET');});
 await expect(f.client.post(refundCommand(),deadline())).rejects.toThrow('GET_DURABLE_BUDGET');
 expect(admitted).toBe(2);expect(f.requests.filter(r=>r.method==='GET')).toHaveLength(1);expect(f.requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});
it('refund POST 401 idempotent replay preserves exact request ID and body',async()=>{
 let posts=0;const f=await fixture(req=>req.path.includes('oauth2')?{body:token}:++posts===1?{status:401,body:{}}:{body:correlatedRefund()});const cmd=refundCommand();
 await f.client.post(cmd,deadline());expect(f.requests.filter(r=>r.path.endsWith('/refund')).map(r=>[r.requestId,r.body])).toEqual(Array(2).fill([cmd.requestId,cmd.canonicalBody]));
});

import { readFileSync } from 'node:fs';
// @ts-expect-error Plain JavaScript helper intentionally has no declarations.
import { createAcceptanceCheckout } from '../../scripts/sandbox-checkout-return.mjs';
const runnerSource=()=>readFileSync(new URL('../../scripts/test-sandbox.mjs',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../../scripts/test-sandbox.mjs',import.meta.url).href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function runOfflineAcceptance(fault:string,late:boolean) {
 let refundGets=0;
 const f=await fixture(req=>{
  if(req.path.includes('oauth2'))return {body:token};
  if(req.path.endsWith('/refund'))return {body:{id:'REF123',status:'COMPLETED'}};
  if(req.path.includes('/refunds/'))return {body:!late||++refundGets>1?refundFault(fault):correlatedRefund()};
  const cap={...capture(),amount:{currency_code:'USD',value:'1.00'}};
  if(req.path.includes('/captures/'))return {body:cap};
  const status=req.method==='POST'?(req.path.endsWith('/capture')?'COMPLETED':'CREATED'):'APPROVED';
  return {body:{...order(status,status==='COMPLETED'),purchase_units:[{...order().purchase_units[0],amount:cap.amount,...(status==='COMPLETED'?{payments:{captures:[cap]}}:{})}]}};
 });
 class Offline extends SandboxPayPal {constructor(config:ConstructorParameters<typeof SandboxPayPal>[0],_transport:typeof fetch,evidence:(e:TransportEvidence)=>void){super(config,f.transport,evidence);}}
 let snapshot:Record<string,any>={};const fakeProcess={env:{PAYPAL_CLIENT_ID:'offline',PAYPAL_CLIENT_SECRET:'offline',PAYPAL_MERCHANT_ID:merchant},stdin:{isTTY:true},stdout:{},on(){},removeListener(){},exitCode:0};
 await new AsyncFunction('assertRefundCorrelation','createAcceptanceCheckout','acceptanceStep','sanitizedAcceptanceError','existsSync','mkdirSync','writeFileSync','randomUUID','createInterface','SandboxPayPal','loadSandboxEnv','sandboxConfig','readModes','process','console',runnerSource())(
 assertRefundCorrelation,createAcceptanceCheckout,acceptanceStep,sanitizedAcceptanceError,()=>false,()=>{},(_path:unknown,body:string)=>{snapshot=JSON.parse(body);},randomUUID,()=>({question:async()=>'',on(){},close(){}}),Offline,()=>{},()=>({clientId:'offline',clientSecret:'offline',merchantId:merchant}),()=>{},fakeProcess,{log(){},error(){}});
 return {snapshot,requests:f.requests,exitCode:fakeProcess.exitCode};
}
for(const late of [false,true])for(const fault of ['parent','amount','currency'])it(`actual acceptance runner rejects ${fault} at ${late?'final GET':'refund enrichment'}`,async()=>{
 const {snapshot,requests,exitCode}=await runOfflineAcceptance(fault,late);
 expect(snapshot.status).toBe('INCOMPLETE_UNKNOWN_RECONCILE_BY_ID');expect(exitCode).toBe(1);expect(snapshot.refundId).toBe('REF123');
 expect(snapshot.failure).toMatchObject({step:late?'refund-get':'refund',error:{code:'PAYPAL_REFUND_CORRELATION_MISMATCH'}});expect(requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});
it.each(['id','pending'])('final acceptance GET independently rejects %s before PASS',async fault=>{
 const {snapshot,exitCode,requests}=await runOfflineAcceptance(fault,true);expect(snapshot.status).toBe('INCOMPLETE_UNKNOWN_RECONCILE_BY_ID');expect(exitCode).toBe(1);expect(snapshot.failure.step).toBe('refund-get');expect(requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});
it('actual acceptance runner accepts fully correlated completed refund',async()=>{const {snapshot,exitCode}=await runOfflineAcceptance('none',true);expect(snapshot.status).toBe('PASS');expect(exitCode).toBe(0);});

import { refund as storedRefund } from '../../src/server/db/repo.ts';
for(const minimal of [false,true])for(const fault of ['parent','amount','currency'])it(`server shared refund correlation ${fault} minimal=${minimal} retains UNKNOWN locator and no credit`,async()=>{
 const s=await ledger();let runtime:ReturnType<typeof createFixtureApp>|undefined;
 try {
  const r=JSON.parse((await s.reserve()).body).reservation;let stage='create';const errors:string[]=[];
  const bad=refundFault(fault);if(fault!=='amount')bad.amount.value='39.99';
  const f=await fixture(req=>{
   if(req.path.includes('oauth2'))return {body:token};
   if(req.path.endsWith('/refund'))return {body:minimal?{id:'REF123',status:'COMPLETED'}:bad};
   if(req.path.includes('/refunds/'))return {body:bad};
   if(req.path.includes('/captures/'))return {body:{...capture(),amount:{currency_code:'USD',value:'39.99'}}};
   const o=order(stage==='create'?'CREATED':stage==='approved'?'APPROVED':'COMPLETED',stage==='captured');
   Object.assign(o.purchase_units[0]!,{custom_id:r.id,invoice_id:r.id,amount:{currency_code:'USD',value:'39.99'}});return {body:o};
  });
  runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client});await runtime.startup(new AbortController().signal);
  const dispatch=(id:string)=>runtime!.dispatcher.dispatch(id,s.context().session,deadline());
  const original=f.client.post.bind(f.client);f.client.post=async(cmd,scope)=>{if(cmd.kind==='ORDER_CAPTURE')stage='captured';try{return await original(cmd,scope);}catch(error){errors.push(sanitizedAcceptanceError(error).code);throw error;}};
  const created=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);await dispatch(created.operationId);stage='approved';
  await runtime.dispatcher.apply(operation(s.db,created.operationId),await f.client.get('order','ORDER123',deadline()));
  const cap=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CAPTURE',{})).body);await dispatch(cap.operationId);
  expect(reservation(s.db,r.id).capturedMinor).toBe(3999);
  const ref=JSON.parse((await s.service.requestRefund(s.context(),'CAP123',3999)).body);await dispatch(ref.operationId);
  expect(errors).toEqual(['PAYPAL_REFUND_CORRELATION_MISMATCH']);expect(operation(s.db,ref.operationId).state).toBe('UNKNOWN');
  expect(storedRefund(s.db,operation(s.db,ref.operationId).subjectId).providerRefundId).toBe('REF123');expect(budget(s.db,'owner',s.period).refundedCompletedMinor).toBe(0);
  const diagnostic=()=>expect(s.db.prepare('SELECT last_error FROM operations WHERE id=?').get(ref.operationId)).toEqual({last_error:'PAYPAL_REFUND_CORRELATION_MISMATCH'});
  diagnostic(); // Production database readback, not the intercepted client exception.
  await dispatch(ref.operationId);
  // Recovery uses the retained refund ID and must preserve the diagnostic.
  await runtime.dispatcher.apply(operation(s.db,ref.operationId),await f.client.get('refund','REF123',deadline()));
  diagnostic();
  expect(operation(s.db,ref.operationId).state).toBe('UNKNOWN');
  expect(storedRefund(s.db,operation(s.db,ref.operationId).subjectId)).toMatchObject({providerRefundId:'REF123',state:'REFUND_UNKNOWN',completedApplied:false});
  expect(budget(s.db,'owner',s.period).refundedCompletedMinor).toBe(0);
  expect(f.requests.filter(req=>req.path.endsWith('/refund'))).toHaveLength(1);
  expect(f.requests.some(req=>req.method==='GET'&&req.path==='/v2/payments/refunds/REF123')).toBe(true);
  const host='127.0.0.1:8787';const session=await runtime.app.request(new Request(`http://${host}/api/session`,{headers:{host,origin:`http://${host}`}}));const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
  const response=await runtime.app.request(new Request(`http://${host}/api/ledger?since=0`,{headers:{host,cookie}}));
  expect(response.status).toBe(200);
  const ledgerView=await response.json();
  expect(ledgerView.rows.filter((row:{note:string})=>row.note==='PAYPAL_REFUND_CORRELATION_MISMATCH')).toEqual([expect.objectContaining({kind:'RECONCILE',amountMinor:0,refundedCompletedAfter:0})]);
  assertLedgerInvariants(s.db);
 }finally{if(runtime)await runtime.shutdown();s.db.close();}
});
it('correlation compares exact minor units rather than decimal string spelling',async()=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:{...correlatedRefund(),amount:{currency_code:'USD',value:'1.0'}}}));
 await expect(f.client.post(refundCommand(),deadline())).resolves.toMatchObject({amount:{value:'1.0'}});
});
it('401 reauthentication cannot extend the original enrichment deadline',async()=>{
 let now=0,auths=0,admissions=0;
 const f=await fixture(req=>{
  if(req.path.includes('oauth2')){if(++auths===2)now=100;return {body:token};}
  return req.method==='POST'?{body:{id:'REF123'}}:{status:401,body:{}};
 },()=>now);
 f.client.bindGetAdmission(async()=>{admissions++;});
 await expect(f.client.post(refundCommand(),{signal:new AbortController().signal,monotonicEndsAt:100})).rejects.toThrow('PROVIDER_DEADLINE');
 expect(auths).toBe(2);expect(admissions).toBe(1);expect(f.requests.filter(r=>r.method==='GET')).toHaveLength(1);expect(f.requests.filter(r=>r.path.endsWith('/refund'))).toHaveLength(1);
});
