import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SandboxPayPal } from '../../src/server/paypal/client.ts';
import type { TransportEvidence } from '../../src/server/paypal/client.ts';
import { SANDBOX_BASE } from '../../src/server/env.ts';
import type { OrderResource } from '../../src/server/paypal/provider.ts';
const servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
const merchant='SELLER123';
const money={currency_code:'USD',value:'10.00'};
const capture=(status='COMPLETED')=>({id:'CAP123',status,amount:money,payee:{merchant_id:merchant},supplementary_data:{related_ids:{order_id:'ORDER123'}}});
const order=(status='CREATED',captures=false)=>({id:'ORDER123',status,purchase_units:[{custom_id:'RES123',invoice_id:'RES123',payee:{merchant_id:merchant},amount:money,...(captures?{payments:{captures:[{id:'CAP123',status:'COMPLETED',amount:money}]}}:{})}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123'}]});
type RequestLog={path:string;method:string;requestId:string|undefined;body:string;auth:string|undefined};
async function fixture(handler:(req:RequestLog,n:number)=>{status?:number;body:unknown;delay?:boolean}) {
 const requests:RequestLog[]=[],evidence:TransportEvidence[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const entry={path:req.url!,method:req.method!,requestId:req.headers['paypal-request-id'] as string|undefined,body,auth:req.headers.authorization};requests.push(entry);const reply=handler(entry,requests.length);if(reply.delay)return;res.writeHead(reply.status??200,{'content-type':'application/json','paypal-debug-id':'DEBUG123'});res.end(typeof reply.body==='string'?reply.body:JSON.stringify(reply.body));});
 servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address() as {port:number};
 // The production client still constructs sandbox-only URLs. Test adapter alone
 // routes their path to this ephemeral local HTTP server.
 const transport:typeof fetch=(input,init)=>{const u=new URL(String(input));expect(u.origin).toBe(SANDBOX_BASE);return fetch(`http://127.0.0.1:${addr.port}${u.pathname}`,init);};
 const client=new SandboxPayPal({clientId:'offline',clientSecret:'offline',merchantId:merchant},transport,e=>evidence.push(e));
 return {client,requests,evidence};
}
const deadline=()=>({signal:new AbortController().signal,monotonicEndsAt:performance.now()+2000});
const command=()=>({kind:'ORDER_CREATE' as const,resourceId:null,requestId:randomUUID(),canonicalBody:'{}'});
const token={access_token:'offline',token_type:'Bearer',expires_in:3600};
describe('offline PayPal-shaped HTTP regression (NOT sandbox acceptance)',()=>{
 it('hard rejects live, alternate sandbox paths, and synthetic merchant configuration',()=>{
  for(const baseUrl of ['https://example.com','https://api-m.sandbox.paypal.com/'])expect(()=>new SandboxPayPal({clientId:'test',clientSecret:'test',merchantId:merchant,baseUrl})).toThrow('SANDBOX_BASE_REQUIRED');
  expect(()=>new SandboxPayPal({clientId:'test',clientSecret:'test',merchantId:'demo-merchant'})).toThrow();
 });
 it('caches OAuth, preserves persisted request id, real link and debug evidence',async()=>{
  const f=await fixture(r=>({body:r.path.includes('oauth2')?token:order()}));const cmd=command();
  const a=await f.client.post(cmd,deadline()) as OrderResource;await f.client.get('order',a.id,deadline());
  expect(f.requests.filter(r=>r.path.includes('oauth2'))).toHaveLength(1);expect(f.requests[1]!.requestId).toBe(cmd.requestId);expect(a.approvalUrl).toContain('sandbox.paypal.com');expect(a.debugId).toBe('DEBUG123');expect(JSON.stringify(f.evidence)).not.toContain('offline-token');
 });
 it('refreshes expired tokens and retries 401 with the SAME request id/body',async()=>{
  let posts=0;const f=await fixture(r=>r.path.includes('oauth2')?{body:token}:++posts===1?{status:401,body:{}}:{body:order()});const cmd=command();await f.client.post(cmd,deadline());
  expect(f.requests.filter(r=>r.path.includes('oauth2'))).toHaveLength(2);expect(f.requests.filter(r=>!r.path.includes('oauth2')).map(r=>[r.requestId,r.body])).toEqual([[cmd.requestId,'{}'],[cmd.requestId,'{}']]);
  const expired=await fixture(r=>({body:r.path.includes('oauth2')?{...token,expires_in:0.001}:order()}));await expired.client.post(command(),deadline());await expired.client.get('order','ORDER123',deadline());expect(expired.requests.filter(r=>r.path.includes('oauth2'))).toHaveLength(2);
 });
 it.each([429,500,503])('does not blindly retry ambiguous HTTP %s; explicit transport retry keeps request id',async status=>{
  let posts=0;const f=await fixture(r=>r.path.includes('oauth2')?{body:token}:++posts===1?{status,body:{}}:{body:order()});const cmd=command();await expect(f.client.post(cmd,deadline())).rejects.toMatchObject({status});expect(posts).toBe(1);await f.client.post(cmd,deadline());expect(f.requests.filter(r=>!r.path.includes('oauth2')).map(r=>r.requestId)).toEqual([cmd.requestId,cmd.requestId]);
 });
 it('requires capture GET and exact payee before returning settlement',async()=>{
  const f=await fixture(r=>({body:r.path.includes('oauth2')?token:r.path.includes('/captures/')?capture():order('COMPLETED',true)}));const result=await f.client.get('order','ORDER123',deadline()) as OrderResource;expect(result.purchase_units[0]!.payments!.captures[0]!.status).toBe('COMPLETED');expect(f.requests.at(-1)!.path).toBe('/v2/payments/captures/CAP123');
  const wrong=await fixture(r=>({body:r.path.includes('oauth2')?token:r.path.includes('/captures/')?{...capture(),payee:{merchant_id:'OTHER'}}:order('COMPLETED',true)}));await expect(wrong.client.get('order','ORDER123',deadline())).rejects.toThrow('PROVIDER_MERCHANT_INVALID');
 });
 it('does not settle from COMPLETED order when capture GET is unavailable',async()=>{
  const f=await fixture(r=>r.path.includes('/captures/')?{status:503,body:{}}:{body:r.path.includes('oauth2')?token:order('COMPLETED',true)});await expect(f.client.get('order','ORDER123',deadline())).rejects.toMatchObject({status:503});
 });
 it('maps documented refund up link, rejecting foreign links without following them',async()=>{
  const f=await fixture(r=>({body:r.path.includes('oauth2')?token:{id:'REF123',status:'COMPLETED',amount:money,links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]}}));const result=await f.client.get('refund','REF123',deadline());expect('supplementary_data' in result && result.supplementary_data.related_ids).toEqual({capture_id:'CAP123'});
 });
 it.each(['{', '{}'])('rejects malformed or incomplete provider JSON %s',async body=>{const f=await fixture(r=>({body:r.path.includes('oauth2')?token:body}));await expect(f.client.get('order','ORDER123',deadline())).rejects.toThrow();});
 it('bounds stalled response by the shared deadline',async()=>{const f=await fixture(r=>r.path.includes('oauth2')?{body:token}:{body:{},delay:true});await expect(f.client.get('order','ORDER123',{signal:new AbortController().signal,monotonicEndsAt:performance.now()+30})).rejects.toThrow();});
});

import { openDb } from '../../src/server/db/db.ts';
import { budget, reservation, operation } from '../../src/server/db/repo.ts';
import { LedgerService } from '../../src/domain/ledger/service.ts';
import { safeDefaults } from '../../src/domain/policy/policy.ts';
import { categoryMap, enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { FixtureDispatcher } from '../../src/server/dispatcher.ts';
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
it('two concurrent spends race one merchant-bound budget; only one obtains the reservation',async()=>{
 const s=await ledger();try {const results=await Promise.allSettled([s.reserve(),s.reserve()]);
 expect(results.filter(r=>r.status==='fulfilled' && JSON.parse(r.value.body).reservation)).toHaveLength(1);
 const b=budget(s.db,'owner',s.period);expect(b.reservedMinor).toBe(3999);expect(b.availableMinor).toBe(1);assertLedgerInvariants(s.db);
 }finally{s.db.close();}
});
it.each(['amount','payee','503'])('dispatcher retains reservation on sandbox %s mismatch or ambiguity',async fault=>{
 const s=await ledger();try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const created=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);
 const f=await fixture(req=>{
  if(req.path.includes('oauth2'))return {body:token};
  if(fault==='503')return {status:503,body:{}};
  const o=order();o.purchase_units[0]!.custom_id=r.id;o.purchase_units[0]!.invoice_id=r.id;
  o.purchase_units[0]!.amount={currency_code:'USD',value:fault==='amount'?'99.99':'39.99'};
  if(fault==='payee')o.purchase_units[0]!.payee.merchant_id='OTHER';return {body:o};
 });
 const dispatcher=new FixtureDispatcher(s.db,f.client);
 await dispatcher.dispatch(created.operationId,s.context().session,deadline());
 expect(reservation(s.db,r.id).holdMinor).toBe(3999);expect(budget(s.db,'owner',s.period).reservedMinor).toBe(3999);
 if(fault!=='amount')expect(operation(s.db,created.operationId).state).toBe('UNKNOWN');
 else expect(reservation(s.db,r.id).anomalyReasons.length).toBeGreaterThan(0);
 assertLedgerInvariants(s.db);
 }finally{s.db.close();}
});

import { createFixtureApp } from '../../src/server/app.ts';
it('sandbox envelope and cookieless callback state remain inert on navigation',async()=>{
 const s=await ledger();try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const created=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);
 const f=await fixture(req=>{const o=order(req.method==='GET'?'APPROVED':'CREATED');o.purchase_units[0]!.custom_id=r.id;o.purchase_units[0]!.invoice_id=r.id;o.purchase_units[0]!.amount={currency_code:'USD',value:'39.99'};return {body:req.path.includes('oauth2')?token:o};});
 const runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client});await runtime.startup(new AbortController().signal);
 await runtime.dispatcher.dispatch(created.operationId,s.context().session,deadline());
 const host='127.0.0.1:8787';
 const health=await runtime.app.request(new Request(`http://${host}/api/health`,{headers:{host}}));expect(health.headers.get('x-paypal-mode')).toBe('sandbox');expect((await health.json()).mode.paypal).toBe('sandbox');
 const state=runtime.session.returnState(r.id,r.id),base=`http://${host}/api/paypal/return?reservation=${r.id}&token=ORDER123&state=`;
 const before=f.requests.length;
 const bad=await runtime.app.request(new Request(base+'wrong',{headers:{host,'sec-fetch-site':'cross-site'}}));expect(bad.status).toBe(403);expect(f.requests.length).toBe(before);
 const returned=await runtime.app.request(new Request(base+state,{headers:{host,'sec-fetch-site':'cross-site'}}));expect(returned.status).toBe(200);expect(await returned.text()).toContain('Approval received by PayPal — return to the app tab to continue.');expect(f.requests.length).toBe(before);
 expect(reservation(s.db,r.id).capturedMinor).toBe(0);expect(reservation(s.db,r.id).holdMinor).toBe(3999);expect(f.requests.filter(req=>req.path.endsWith('/capture'))).toHaveLength(0);
 await runtime.shutdown();
 }finally{s.db.close();}
});
it('persisted database rejects a switch between fixture and sandbox',()=>{
 const db=openDb(':memory:');try{createFixtureApp({db});expect(()=>createFixtureApp({db,provider:new SandboxPayPal({clientId:'offline',clientSecret:'offline',merchantId:merchant})})).toThrow('PERSISTED_PROVIDER_BINDING_MISMATCH');}finally{db.close();}
});

// Reviewer official-shape regressions. Offline only; schemas retained read-only.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, run } from '../../src/server/db/repo.ts';
import { withImmediate } from '../../src/server/db/db.ts';
import { FixtureRecovery } from '../../src/server/recovery.ts';
const schemas=JSON.parse(readFileSync(new URL('../fixtures/paypal/orders-examples.json',import.meta.url),'utf8'));
const official=(path:string,method:string,code:string,name:string)=>structuredClone(schemas.paths[path][method].responses[code].content['application/json'].examples[name].value);
it('F1 retains minimal successful POST identity before unsupported full GET and keeps hold',async()=>{
 const s=await ledger();try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const op=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);
 const minimal=official('/v2/checkout/orders','post','200','samples_orders_create_samples_orders_create_00_orders_create');
 const full=official('/v2/checkout/orders/{id}','get','200','samples_orders_get_00_orders_get');full.id=minimal.id;
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:req.method==='POST'?minimal:full}));
 await new FixtureDispatcher(s.db,f.client).dispatch(op.operationId,s.context().session,deadline());
 expect(reservation(s.db,r.id).orderId).toBe(minimal.id);expect(operation(s.db,op.operationId).state).toBe('UNKNOWN');expect(reservation(s.db,r.id).holdMinor).toBe(3999);
 expect(f.requests.some(x=>x.method==='GET')).toBe(true);
 await expect(f.client.get('order',minimal.id,deadline())).rejects.toThrow('PAYPAL_ORDER_MERCHANT_UNSUPPORTED');
 }finally{s.db.close();}
});
it.each(['REFUNDED','PARTIALLY_REFUNDED'])('F2 independently reads documented %s gross capture',async status=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:req.path.includes('/captures/')?capture(status):order('COMPLETED',true)}));
 const result=await f.client.get('order','ORDER123',deadline()) as OrderResource;
 expect(result.purchase_units[0]!.payments!.captures[0]!.status).toBe(status);expect(result.purchase_units[0]!.payments!.captures[0]!.amount).toEqual(money);
});
it('F3 counts nested wire GET and 401 retry durably across recovery restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paypal-get-'));const dbPath=join(dir,'ledger.sqlite');
 const s=await ledger(dbPath);try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const op=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);
 let recovering=false,first=true;
 const f=await fixture(req=>{
 if(req.path.includes('oauth2'))return {body:token};
 if(recovering && first){first=false;return {status:401,body:{}};}
 const o=order(recovering?'COMPLETED':'CREATED',recovering);o.purchase_units[0]!.custom_id=r.id;o.purchase_units[0]!.invoice_id=r.id;o.purchase_units[0]!.amount={currency_code:'USD',value:'39.99'};
 return {body:req.path.includes('/captures/')?{...capture(),amount:{currency_code:'USD',value:'39.99'}}:o};
 });
 const d=new FixtureDispatcher(s.db,f.client);await d.dispatch(op.operationId,s.context().session,deadline());
 await withImmediate(s.db,()=>run(s.db,"UPDATE operations SET state='UNKNOWN',next_get_at=0 WHERE id=?",op.operationId));recovering=true;
 const before=f.requests.filter(x=>x.method==='GET').length;
 await new FixtureRecovery(s.db,d,'owner').run(deadline(),'startup',r.id);
 expect(operation(s.db,op.operationId).getAttempts).toBe(f.requests.filter(x=>x.method==='GET').length-before);
 expect(operation(s.db,op.operationId).getAttempts).toBe(3);
 s.db.close();s.db=openDb(dbPath);
 await withImmediate(s.db,()=>run(s.db,"UPDATE operations SET state='UNKNOWN',get_attempts=23,next_get_at=0 WHERE id=?",op.operationId));
 const count=f.requests.filter(x=>x.method==='GET').length;
 await new FixtureRecovery(s.db,new FixtureDispatcher(s.db,f.client),'owner').run(deadline(),'startup',r.id);
 expect(f.requests.filter(x=>x.method==='GET').length-count).toBe(1);expect(operation(s.db,op.operationId).getAttempts).toBe(24);
 }finally{s.db.close();rmSync(dir,{recursive:true});}
});
it.each(['https://sandbox.paypal.com/arbitrary-path','https://www.sandbox.paypal.com/checkoutnow?token=OTHER','https://www.sandbox.paypal.com/signin?returnUri='+SANDBOX_BASE.replace('api-m.sandbox','www')+'/'])('F4 refuses unbound checkout %s',async href=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:{...order(),links:[{rel:'approve',href}]}}));await expect(f.client.get('order','ORDER123',deadline())).rejects.toThrow('PAYPAL_APPROVAL_URL_INVALID');
});
it.each(['fixture','sandbox'] as const)('F5 refusal ledger uses bound %s mode',async mode=>{
 const s=await ledger();try {
 const {bindLedgerMode}=await import('../../src/server/db/repo.ts');bindLedgerMode(s.db,mode,merchant);
 const p=s.signed;
 await s.service.reserve(s.context(),{proposalId:randomUUID(),mandateId:'mandate',lines:[{sku:'GFT-050',qty:1}],source:{kind:'owner'}},p.contentHash,true);
 expect(all(s.db,"SELECT source FROM ledger_rows WHERE kind='REJECT'").at(-1)?.['source']).toBe(mode);
 }finally{s.db.close();}
});

it('F2 capture, partial refund, GET, full refund and disk reload preserve gross and exact refund totals',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paypal-refund-')),path=join(dir,'ledger.sqlite');
 const s=await ledger(path);let runtime:ReturnType<typeof createFixtureApp>|undefined;
 try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 let stage='create',refundNumber=0,unsupported=false;
 const f=await fixture(req=>{
 if(req.path.includes('oauth2'))return {body:token};
 if(req.path.includes('/refunds/'))return {body:{id:req.path.split('/').at(-1),status:'COMPLETED',amount:{currency_code:'USD',value:req.path.endsWith('REF1')?'10.00':'29.99'},links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]}};
 if(req.path.endsWith('/refund'))return {body:{id:`REF${++refundNumber}`,status:'COMPLETED',amount:JSON.parse(req.body).amount,links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]}};
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
 const refundPart=async(amount:number)=>{const op=JSON.parse((await s.service.requestRefund(s.context(),'CAP123',amount)).body);await dispatch(op.operationId);const current=operation(s.db,op.operationId);const resource=await f.client.get('refund',`REF${refundNumber}`,deadline());await runtime!.dispatcher.apply(current,resource);await runtime!.dispatcher.apply(current,resource);};
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
it('F1 official sparse capture POST enriches from GET, never request fields',async()=>{
 const raw=official('/v2/checkout/orders/{id}/capture','post','201','samples_orders_capture_00_orders_capture');
 const f=await fixture(req=>{const full=order('COMPLETED',true);full.id=raw.id;full.links=[];return {body:req.path.includes('oauth2')?token:req.method==='POST'?raw:req.path.includes('/captures/')?{...capture(),supplementary_data:{related_ids:{order_id:raw.id}}}:full};});
 const result=await f.client.post({...command(),kind:'ORDER_CAPTURE',resourceId:raw.id},deadline()) as OrderResource;
 expect(result.purchase_units[0]!.custom_id).toBe('RES123');expect(f.requests.filter(x=>x.method==='GET')).toHaveLength(2);
});
it.each([undefined,{email_address:'merchant@example.com'}])('F1 missing or email-only payee is explicitly unsupported',async payee=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:{...order('APPROVED'),purchase_units:[{...order().purchase_units[0],payee}]}}));await expect(f.client.get('order','ORDER123',deadline())).rejects.toThrow('PAYPAL_ORDER_MERCHANT_UNSUPPORTED');
});
it.each(['status','amount','currency','merchant','order','custom','invoice','email','missing'])('F1 fresh capture preflight blocks %s without spending or releasing hold',async fault=>{
 const s=await ledger();try {
 const r=JSON.parse((await s.reserve()).body).reservation;let stage=false;
 const f=await fixture(req=>{
 const o:Record<string,unknown>=order('APPROVED');
 const u=(o['purchase_units'] as Record<string,unknown>[])[0]!;u['custom_id']=r.id;u['invoice_id']=r.id;u['amount']={currency_code:'USD',value:'39.99'};
 if(stage){if(fault==='status')o['status']='CREATED';if(fault==='order')o['id']='OTHER';if(fault==='amount')u['amount']={currency_code:'USD',value:'99.99'};if(fault==='currency')u['amount']={currency_code:'EUR',value:'39.99'};if(fault==='merchant')u['payee']={merchant_id:'OTHER'};if(fault==='email')u['payee']={email_address:'merchant@example.com'};if(fault==='missing')delete u['payee'];if(fault==='custom')u['custom_id']='OTHER';if(fault==='invoice')u['invoice_id']='OTHER';}
 return {body:req.path.includes('oauth2')?token:o};
 });
 const d=new FixtureDispatcher(s.db,f.client),op=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);await d.dispatch(op.operationId,s.context().session,deadline());
 const cap=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CAPTURE',{})).body);stage=true;
 await expect(d.dispatch(cap.operationId,s.context().session,deadline())).rejects.toThrow();
 expect(f.requests.filter(x=>x.path.endsWith('/capture'))).toHaveLength(0);expect(reservation(s.db,r.id).holdMinor).toBe(3999);expect(operation(s.db,cap.operationId).state).toBe('READY');
 }finally{s.db.close();}
});

it.each(['/checkoutnow','/app-switch-checkout'])('F4 admits documented token-bound %s links',async path=>{
 const f=await fixture(req=>({body:req.path.includes('oauth2')?token:{...order(),links:[{rel:'payer-action',href:`https://www.sandbox.paypal.com${path}?token=ORDER123`}]}}));
 const result=await f.client.get('order','ORDER123',deadline()) as OrderResource;expect(result.approvalUrl).toContain(`${path}?token=ORDER123`);
});

it.each([{kind:'capture',age:60001},{kind:'refund',age:60001},{kind:'capture',age:86400001},{kind:'refund',age:86400001}])('R1 reload exhaustion then UNKNOWN $kind resolves manually after restart at $age ms without POST',async ({kind,age})=>{
 const dir=mkdtempSync(join(tmpdir(),'paypal-r1-')),path=join(dir,'ledger.sqlite'),s=await ledger(path);
 let now=0;const clock={wallNow:()=>Date.now()+now,monotonicNow:()=>performance.now()};
 try {
 const r=JSON.parse((await s.reserve()).body).reservation;let stage='approved',ambiguous=false;
 const f=await fixture(req=>{
 if(req.path.includes('oauth2'))return {body:token};
 if(req.method==='POST' && req.path.endsWith('/capture')){stage='captured';if(ambiguous)return {status:503,body:{}};}
 if(req.path.endsWith('/refund'))return {body:{id:'REF123',status:'COMPLETED'}}; // locator persisted, invalid shape => UNKNOWN
 if(req.path.includes('/refunds/'))return {body:{id:'REF123',status:stage==='positive'?'COMPLETED':'PENDING',amount:{currency_code:'USD',value:'39.99'},links:[{rel:'up',href:SANDBOX_BASE+'/v2/payments/captures/CAP123'}]}};
 if(req.path.includes('/captures/'))return {body:{...capture(),amount:{currency_code:'USD',value:'39.99'}}};
 const o=order(stage==='approved'?'APPROVED':'COMPLETED',stage!=='approved');Object.assign(o.purchase_units[0]!,{custom_id:r.id,invoice_id:r.id,amount:{currency_code:'USD',value:'39.99'}});return {body:o};
 });
 let d=new FixtureDispatcher(s.db,f.client,clock);
 const create=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);await d.dispatch(create.operationId,s.context().session,deadline());
 // More page inspections than the old lifetime allowance, before the payment claim.
 for(let i=0;i<25;i++)await f.client.get('order','ORDER123',deadline());
 const cap=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CAPTURE',{})).body);ambiguous=kind==='capture';await d.dispatch(cap.operationId,s.context().session,deadline());
 let id=cap.operationId;
 if(kind==='refund'){const ref=JSON.parse((await s.service.requestRefund(s.context(),'CAP123',3999)).body);id=ref.operationId;await d.dispatch(id,s.context().session,deadline());}
 expect(operation(s.db,id).state).toBe('UNKNOWN');
 const original=operation(s.db,id),posts=f.requests.filter(x=>x.method==='POST'&&!x.path.includes('oauth2')).length;
 s.db.close();s.db=openDb(path);d=new FixtureDispatcher(s.db,f.client,clock);
 // Exercise explicit reconciliation on restart while the provider is still pending/unavailable.
 if(kind==='capture')stage='approved';
 let recovery=new FixtureRecovery(s.db,d,'owner',clock);await recovery.run(deadline(),'manual',r.id);
 expect(operation(s.db,id).state).toBe('UNKNOWN');
 now+=age;
 await withImmediate(s.db,()=>run(s.db,'UPDATE operations SET get_attempts=24 WHERE id=?',id));
 stage='positive';s.db.close();s.db=openDb(path);d=new FixtureDispatcher(s.db,f.client,clock);recovery=new FixtureRecovery(s.db,d,'owner',clock);
 await recovery.run(deadline(),'manual',r.id);
 const after=operation(s.db,id);expect(after.state).toBe('DONE');
 expect([after.requestId,after.attempt,after.ownerToken,after.horizonUntil,after.getAttempts]).toEqual([original.requestId,1,original.ownerToken,original.horizonUntil,24]);
 expect(reservation(s.db,r.id).capturedMinor).toBe(3999);expect(reservation(s.db,r.id).holdMinor).toBe(0);
 if(kind==='refund')expect(budget(s.db,'owner',s.period).refundedCompletedMinor).toBe(3999);
 expect(f.requests.filter(x=>x.method==='POST'&&!x.path.includes('oauth2'))).toHaveLength(posts);
 const gets=f.requests.filter(x=>x.method==='GET').length;
 await expect(recovery.run(deadline(),'manual',r.id)).rejects.toThrow('RECONCILE_RATE_429');
 expect(f.requests.filter(x=>x.method==='GET')).toHaveLength(gets);assertLedgerInvariants(s.db);
 }finally{s.db.close();rmSync(dir,{recursive:true});}
});

it('R1 manual allowance is durable, audited and bounded across repeated passes; foreground cannot spend it',async()=>{
 const s=await ledger();let offset=0;const clock={wallNow:()=>Date.now()+offset,monotonicNow:()=>performance.now()};
 try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const f=await fixture(req=>{const o=order('APPROVED');Object.assign(o.purchase_units[0]!,{custom_id:r.id,invoice_id:r.id,amount:{currency_code:'USD',value:'39.99'}});return {body:req.path.includes('oauth2')?token:o};});
 const d=new FixtureDispatcher(s.db,f.client,clock),create=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);await d.dispatch(create.operationId,s.context().session,deadline());
 for(let i=0;i<60;i++)await f.client.get('order','ORDER123',deadline());
 await expect(f.client.get('order','ORDER123',deadline())).rejects.toThrow('GET_RESOURCE_BUDGET_EXHAUSTED');
 expect(all(s.db,"SELECT * FROM wire_get_lanes WHERE purpose!='foreground'")).toHaveLength(0);
 const before=f.requests.filter(x=>x.method==='GET').length;
 for(let i=0;i<30;i++){
  const recovery=new FixtureRecovery(s.db,d,'owner',clock);
  await recovery.run(deadline(),'manual',r.id);
  await expect(recovery.run(deadline(),'manual',r.id)).rejects.toThrow('RECONCILE_RATE_429');
  offset+=60001;
 }
 expect(f.requests.filter(x=>x.method==='GET').length-before).toBe(24);
 expect(all(s.db,"SELECT * FROM wire_get_admissions WHERE purpose='manual'")).toHaveLength(24);
 expect(all(s.db,'SELECT * FROM wire_get_admissions')).toHaveLength(f.requests.filter(x=>x.method==='GET').length);
 offset+=3600000;await new FixtureRecovery(s.db,d,'owner',clock).run(deadline(),'manual',r.id);
 expect(f.requests.filter(x=>x.method==='GET').length-before).toBe(25);
 expect(operation(s.db,create.operationId).attempt).toBe(1);
 }finally{s.db.close();}
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationAction, paymentLabels } from '../../src/web/review-policy.ts';

describe('production payment action rendering', () => {
 for (const sandbox of [false, true]) {
  it(`labels READY and DONE honestly in ${sandbox ? 'sandbox' : 'fixture'} mode`, () => {
   const ready = renderToStaticMarkup(createElement(OperationAction, { state: 'READY', sandbox, disabled: false, onRun: () => {} }));
   const done = renderToStaticMarkup(createElement(OperationAction, { state: 'DONE', sandbox, disabled: false, onRun: () => {} }));
   expect(ready).toContain(sandbox ? 'Run sandbox operation' : 'Run simulated operation');
   expect(done).toContain(sandbox ? 'Sandbox result recorded' : 'Simulated result recorded');
   for (const text of [ready, done, ...Object.values(paymentLabels(sandbox))]) {
    expect(text.toLowerCase()).toContain(sandbox ? 'sandbox' : 'simulat');
    if (sandbox) expect(text.toLowerCase()).not.toContain('simulat');
   }
  });
 }
 it('keeps UNKNOWN and MANUAL actions without a dispatch button', () => {
  for (const state of ['UNKNOWN', 'MANUAL'] as const) {
   const html = renderToStaticMarkup(createElement(OperationAction, { state, sandbox: true, disabled: false, onRun: () => { throw new Error('must not send'); } }));
   expect(html).not.toContain('<button');expect(html).toContain('No replacement POST');
  }
 });
});
