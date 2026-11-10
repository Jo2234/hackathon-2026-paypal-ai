import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SandboxPayPal } from '../../src/server/paypal/client.ts';
import type { TransportEvidence } from '../../src/server/paypal/client.ts';
import { SANDBOX_BASE } from '../../src/server/env.ts';
import { validateResource } from '../../src/server/paypal/provider.ts';
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
 const client=new SandboxPayPal({clientId:'test',clientSecret:'test',merchantId:merchant},transport,e=>evidence.push(e));
 return {client,requests,evidence};
}
const deadline=()=>({signal:new AbortController().signal,monotonicEndsAt:performance.now()+2000});
const token={access_token:'mock',token_type:'Bearer',expires_in:3600};

import { openDb } from '../../src/server/db/db.ts';
import { reservation, operation } from '../../src/server/db/repo.ts';
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

import { createFixtureApp } from '../../src/server/app.ts';
it.each(['APPROVED','COMPLETED'].flatMap(status=>['127.0.0.1:8787','127.0.0.1:5173'].map(host=>({status,host}))))('sandbox callback $status on $host navigates without capture and preserves cancel guidance',async ({status,host})=>{
 const s=await ledger();try {
 const r=JSON.parse((await s.reserve()).body).reservation;
 const f=await fixture(req=>{const o=order(req.method==='GET'?status:'CREATED');o.purchase_units[0]!.custom_id=r.id;o.purchase_units[0]!.invoice_id=r.id;o.purchase_units[0]!.amount={currency_code:'USD',value:'39.99'};return {body:req.path.includes('oauth2')?token:o};});
 const runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client,host});await runtime.startup(new AbortController().signal);
 const bootstrap=await runtime.app.request(new Request(`http://${host}/api/session`,{headers:{host,origin:`http://${host}`}}));
 const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0]!,csrf=(await bootstrap.json()).csrfNonce;
 const checkout=await runtime.app.request(new Request(`http://${host}/api/reservations/${r.id}/checkout`,{method:'POST',headers:{host,origin:`http://${host}`,cookie,'x-csrf-nonce':csrf,'idempotency-key':randomUUID(),'content-type':'application/json'},body:'{}'}));
 expect(checkout.status).toBe(202);const created=await checkout.json();
 await runtime.dispatcher.dispatch(created.operationId,s.context().session,deadline());
 const payload=JSON.parse(f.requests.find(req=>req.path==='/v2/checkout/orders'&&req.method==='POST')!.body);
 const ctx=payload.payment_source.paypal.experience_context;
 expect(ctx.user_action).toBe('PAY_NOW');expect(ctx.return_url).toContain(`http://${host}/api/paypal/return?reservation=${r.id}&state=`);expect(ctx.cancel_url).toContain(`http://${host}/api/paypal/cancel?reservation=${r.id}&state=`);
 const health=await runtime.app.request(new Request(`http://${host}/api/health`,{headers:{host}}));expect(health.headers.get('x-paypal-mode')).toBe('sandbox');expect((await health.json()).mode.paypal).toBe('sandbox');
 const state=runtime.session.returnState(r.id,r.id),base=`http://${host}/api/paypal/return?reservation=${r.id}&token=ORDER123&state=`;
 const before=f.requests.length;
 const bad=await runtime.app.request(new Request(base+'wrong',{headers:{host,'sec-fetch-site':'cross-site'}}));expect(bad.status).toBe(403);expect(f.requests.length).toBe(before);
 const foreign=createFixtureApp({db:s.db,ownerId:'other-owner',provider:f.client,host});
 expect((await foreign.app.request(new Request(base+foreign.session.returnState(r.id,r.id),{headers:{host}}))).status).toBe(403);
 await foreign.shutdown();
 const returned=await runtime.app.request(new Request(base+state,{headers:{host,cookie,'sec-fetch-site':'cross-site'}}));expect(returned.status).toBe(303);expect(f.requests.at(-1)!.method).toBe('GET');
 expect(returned.headers.get('location')).toBe(`/cart?r=${r.id}&mode=sandbox&checkout=returned`);
 expect((await runtime.app.request(new Request(base+state,{headers:{host:'localhost:8787'}}))).status).toBe(403);
 for(const url of [base+state+'&token=OTHER',base.replace('token=ORDER123','token=OTHER')+state,base])expect((await runtime.app.request(new Request(url,{headers:{host}}))).status).toBe(403);
 const cancelled=await runtime.app.request(new Request((base+state).replace('/return?','/cancel?'),{headers:{host,cookie}}));expect(cancelled.headers.get('location')).toContain('checkout=cancelled');
 for(let i=0;i<65;i++)await runtime.app.request(new Request(base+state,{headers:{host,cookie}}));
 expect(f.requests.filter(x=>x.method==='GET').length).toBeLessThanOrEqual(60);
 expect(reservation(s.db,r.id).capturedMinor).toBe(0);expect(reservation(s.db,r.id).holdMinor).toBe(3999);expect(f.requests.filter(req=>req.path.endsWith('/capture'))).toHaveLength(0);
 const completed=order('COMPLETED',true);Object.assign(completed.purchase_units[0]!,{custom_id:r.id,invoice_id:r.id,amount:{currency_code:'USD',value:'39.99'}});Object.assign(completed.purchase_units[0]!.payments!.captures[0]!,{...capture(),amount:{currency_code:'USD',value:'39.99'}});
 await runtime.dispatcher.apply(operation(s.db,created.operationId),validateResource('order',completed,merchant));
 expect(reservation(s.db,r.id).capturedMinor).toBe(3999);
 const gets=f.requests.filter(x=>x.method==='GET').length;
 expect((await runtime.app.request(new Request(base+state,{headers:{host,cookie}}))).status).toBe(303);
 expect(f.requests.filter(x=>x.method==='GET')).toHaveLength(gets);assertLedgerInvariants(s.db);
 await runtime.shutdown();
 }finally{s.db.close();}
});

import { all } from '../../src/server/db/repo.ts';
// Read every table, including durable transport counters, not only money rows.
const snapshot=(db:ReturnType<typeof openDb>)=>all(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row=>[row['name'],all(db,`SELECT * FROM "${String(row['name']).replaceAll('"','""')}" ORDER BY rowid`)]);
for(const authenticated of [false,true])for(const route of ['return','cancel'])it(`callback replay N=65 authenticated=${authenticated} ${route} preserves capture and settlement capacity`,async()=>{
 const s=await ledger();let runtime:ReturnType<typeof createFixtureApp>|undefined;
 try {
  const r=JSON.parse((await s.reserve()).body).reservation;let paid=false,callback401=false;
  const f=await fixture(req=>{
   if(req.path.includes('oauth2'))return {body:token};
   if(callback401 && req.method==='GET'){callback401=false;return {status:401,body:{}};}
   if(req.method==='POST'&&req.path.endsWith('/capture'))paid=true;
   if(req.path.includes('/captures/'))return {body:{...capture(),amount:{currency_code:'USD',value:'39.99'}}};
   const o=order(paid?'COMPLETED':'APPROVED',paid);
   Object.assign(o.purchase_units[0]!,{custom_id:r.id,invoice_id:r.id,amount:{currency_code:'USD',value:'39.99'}});
   if(paid)Object.assign(o.purchase_units[0]!.payments!.captures[0]!,{amount:{currency_code:'USD',value:'39.99'}});
   return {body:o};
  });
  const host='127.0.0.1:8787';runtime=createFixtureApp({db:s.db,ownerId:'owner',provider:f.client,host});await runtime.startup(new AbortController().signal);
  const bootstrap=await runtime.app.request(new Request(`http://${host}/api/session`,{headers:{host,origin:`http://${host}`}}));
  const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0]!;
  const created=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CREATE',{})).body);
  await runtime.dispatcher.dispatch(created.operationId,s.context().session,deadline());
  const url=`http://${host}/api/paypal/${route}?reservation=${r.id}&token=ORDER123&state=${runtime.session.returnState(r.id,r.id)}&PayerID=%3Cscript%3Eevil%3C/script%3E`;
  const before=snapshot(s.db),getsBefore=f.requests.filter(req=>req.method==='GET').length;
  const lanesBefore=all(s.db,"SELECT * FROM wire_get_lanes WHERE purpose IN('foreground','automatic','manual') ORDER BY path,purpose");
  callback401=authenticated && route==='cancel'; // Reauthentication must not send a second callback GET.
  for(let i=0;i<65;i++) {
   const wireBefore=f.requests.filter(req=>req.method==='GET').length;
   const res=await runtime.app.request(new Request(url,{headers:{host,'sec-fetch-site':'cross-site',...(authenticated?{cookie}:{})}}));
   expect(f.requests.filter(req=>req.method==='GET').length-wireBefore).toBeLessThanOrEqual(1);
   if(authenticated){expect(res.status).toBe(303);expect(res.headers.get('location')).toContain(`/cart?r=${r.id}`);}
   else {
    expect(res.status).toBe(200);expect(res.headers.get('content-type')).toContain('text/html');
    const html=await res.text();
    const title=route==='cancel'?'PayPal cancellation':'PayPal approval';
    const message=route==='cancel'?'Checkout cancelled at PayPal — return to the app tab.':'Approval received by PayPal — return to the app tab to continue.';
    expect(html).toBe(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><p>${message}</p></html>`);
    expect(html).not.toContain(r.id);
    expect(html).not.toContain('ORDER123');expect(html).not.toContain('evil');expect(html).not.toContain(runtime.session.returnState(r.id,r.id));
   }
  }
  if(!authenticated)for(const invalidCookie of ['mandate_owner=invalid',`${cookie}; ${cookie}`]){
   const res=await runtime.app.request(new Request(url,{headers:{host,cookie:invalidCookie}}));
   expect(res.status).toBe(200);expect(await res.text()).toContain('return to the app tab');
  }
  const callbackGets=f.requests.filter(req=>req.method==='GET').length-getsBefore;
  if(authenticated){expect(callbackGets).toBe(4);expect(all(s.db,"SELECT * FROM wire_get_lanes WHERE purpose='callback'")).toEqual([expect.objectContaining({attempts:4})]);}
  else {expect(callbackGets).toBe(0);expect(snapshot(s.db)).toEqual(before);}
  expect(all(s.db,"SELECT * FROM wire_get_lanes WHERE purpose IN('foreground','automatic','manual') ORDER BY path,purpose")).toEqual(lanesBefore);
  expect(reservation(s.db,r.id).capturedMinor).toBe(0);expect(f.requests.filter(req=>req.path.endsWith('/capture'))).toHaveLength(0);
  // Normal owner refresh, mandatory capture approval preflight, actual POST,
  // then GET-confirmed manual settlement. No counter reset or synthetic apply.
  expect((await runtime.app.request(new Request(`http://${host}/api/reservations/${r.id}`,{headers:{host,cookie}}))).status).toBe(200);
  const cap=JSON.parse((await s.service.preparePurchase(s.context(),r.id,'ORDER_CAPTURE',{})).body);
  await runtime.dispatcher.dispatch(cap.operationId,s.context().session,deadline());
  const beforeSettle=f.requests.length;
  await runtime.recovery.run(deadline(),'manual',r.id);
  expect(f.requests.slice(beforeSettle).some(req=>req.method==='GET')).toBe(true);
  expect(operation(s.db,cap.operationId).state).toBe('DONE');expect(reservation(s.db,r.id).capturedMinor).toBe(3999);
  expect(f.requests.filter(req=>req.path.endsWith('/capture'))).toHaveLength(1);assertLedgerInvariants(s.db);
 }finally{await runtime?.shutdown();s.db.close();}
});
