import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildNarrowRequest,buildDraftPolicy,buildCartProposal,MODEL,API_DIGEST} from '../../src/server/llm/narrow.ts';
import {callOllamaNative,parseOllamaNativeResponse,directLocalFetch,type Dependencies,type NativeRequest,type Capture} from '../../src/server/llm/ollama-native.ts';
import {evaluateCart} from '../../src/domain/engine/engine.ts';
import {enforcementCatalogue,categoryMap} from '../../src/domain/engine/catalogue.ts';
const enc=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x));
const extraction={allowanceUSD:60,perOrderMaxUSD:40,perLineMaxUSD:10,stepUpThresholdUSD:20,allowedCategories:['coffee_tea','printer_supplies'],deniedCategories:['gift_cards','alcohol']};
const context={ownerId:'owner',mandateId:'mandate',merchantId:'merchant',version:2,ownerText:'Allow $60 weekly',now:Date.UTC(2026,10,10)};
const selection={sku:'COF-001',qty:1};
const envelope=(content:unknown=selection,extra={})=>({model:MODEL,done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(content)},...extra});
const input=():NativeRequest=>({endpoint:'http://127.0.0.1:59814/api/chat',task:'selection',ownerText:'Buy exactly 1 Ground coffee.',deadlineMs:Date.now()+5000,maxRequestBytes:65536,maxResponseBytes:262144});
function stub(reply:()=>Response=()=>new Response(enc(envelope())),tag=API_DIGEST){
 const calls:{url:string;init:RequestInit}[]=[],events:Capture[]=[];
 const deps:Dependencies={fetch:async(url,init)=>{calls.push({url,init});if(url.endsWith('/api/version'))return new Response(enc({version:'0.40.15'}));if(url.endsWith('/api/tags'))return new Response(enc({models:[{name:MODEL,digest:tag}]}));return reply();},now:Date.now,setTimer:(cb,ms)=>setTimeout(cb,ms),clearTimer:h=>clearTimeout(h as ReturnType<typeof setTimeout>),capture:e=>events.push(e)};
 return {deps,calls,events};
}
test('exact qualified requests including verbatim prompts, schemas, options and choice order',()=>{
 const c=JSON.parse(readFileSync(new URL('../fixtures/native-qualified-config.json',import.meta.url),'utf8'));
 for(const [task,key] of [['extraction','compileRequestTemplate'],['selection','proposalRequestTemplate']] as const){
  const t=c[key],u=JSON.parse(t.messages[1].content),text=task==='extraction'?u.ownerText:u.goal;
  assert.deepEqual(buildNarrowRequest(task,text),t);
 }
});
test('only six fields inferred; unsigned defaults preserved; metadata server-owned',()=>{
 const d=buildDraftPolicy(extraction,context);
 assert.equal(d.allowanceMinor,6000);assert.equal(d.perLineMaxMinor,1000);assert.equal(d.status,'DRAFT');assert.equal(d.signedAt,null);assert.equal(d.contentHash,null);
 assert.equal(d.refundRestoration,'never_restore');assert.equal(d.maxQuantityPerLine,5);assert.equal(d.maxLinesPerCart,10);
 assert.equal(d.expiresAt,new Date(context.now+30*86400000).toISOString());assert.equal(d.ownerId,'owner');assert.equal(d.version,2);
 for(const n of [0,-1,500.01,1.001,Infinity,NaN])assert.throws(()=>buildDraftPolicy({...extraction,allowanceUSD:n},context));
 for(const cats of [['unknown'],['coffee_tea','coffee_tea']])assert.throws(()=>buildDraftPolicy({...extraction,allowedCategories:cats},context));
 assert.throws(()=>buildDraftPolicy({...extraction,deniedCategories:['coffee_tea']},context));
 assert.throws(()=>buildDraftPolicy({...extraction,perLineMaxUSD:41},context));
 assert.throws(()=>buildDraftPolicy({...extraction,status:'ACTIVE'},context));
});
test('selection validation and current engine enforcement, no model authorization',()=>{
 const c={proposalId:'proposal',mandateId:'mandate'};
 for(const s of [{sku:'UNKNOWN',qty:1},{sku:null,qty:1},{sku:'COF-001',qty:0},{sku:'COF-001',qty:6},{sku:'COF-001',qty:1.5},{...selection,price:1}])assert.throws(()=>buildCartProposal(s,c));
 assert.deepEqual(buildCartProposal({sku:null,qty:0},c).lines,[]);
 const d=buildDraftPolicy({...extraction,perLineMaxUSD:30},context),p={...d,status:'ACTIVE' as const,contentHash:'a'.repeat(64)};
 const b={availableMinor:6000,spendBlocked:false} as Parameters<typeof evaluateCart>[4];
 const verdict=evaluateCart(p,enforcementCatalogue,categoryMap,buildCartProposal({sku:'GFT-050',qty:1},c),b,context.now,false,'merchant');
 assert.ok(verdict.ruleIds.includes('R05_CATEGORY_DENIED'));
 const over=evaluateCart(p,enforcementCatalogue,categoryMap,buildCartProposal({sku:'COF-001',qty:5},c),b,context.now,false,'merchant');
 assert.ok(over.ruleIds.includes('R09_LINE_MAX'));assert.ok(over.ruleIds.includes('R10_ORDER_MAX'));
});
test('native parser rejects malformed/truncated/wrong-model/thinking/tools/domain output',()=>{
 const invalid=[enc({}),new TextEncoder().encode('{'),enc(envelope(selection,{done:false})),enc(envelope(selection,{done_reason:'length'})),enc(envelope(selection,{model:'other'})),enc(envelope({sku:'unknown',qty:1})),enc(envelope(selection,{message:{role:'assistant',content:'{'}})),enc(envelope(selection,{message:{role:'assistant',content:JSON.stringify(selection),thinking:'hidden'}})),enc(envelope(selection,{message:{role:'assistant',content:JSON.stringify(selection),tool_calls:[]}})),new Uint8Array([255])];
 for(const b of invalid)assert.equal(parseOllamaNativeResponse(b,200,'selection').kind,'invalid_output');
 assert.equal(parseOllamaNativeResponse(enc(envelope()),503,'selection').kind,'transport_error');
 assert.equal(parseOllamaNativeResponse(enc(envelope()),200,'selection').kind,'tool_call');
 assert.equal(parseOllamaNativeResponse(enc(envelope({...extraction,allowedCategories:['unknown']})),200,'extraction').kind,'invalid_output');
});
test('runtime identity verified before one inference; captures metadata and native raw bytes',async()=>{
 const s=stub(),r=await callOllamaNative(input(),s.deps);
 assert.equal(r.kind,'tool_call');assert.equal(r.attempts,1);assert.equal(r.retries,0);assert.equal(s.calls.length,3);assert.equal(s.events.length,6);
 assert.deepEqual(s.calls.map(c=>new URL(c.url).pathname),['/api/version','/api/tags','/api/chat']);
 assert.equal(s.calls[2]!.init.redirect,'error');
 for(const digest of ['a'.repeat(64),'',`sha256:${'a'.repeat(64)}`]){const bad=stub(undefined,digest);const r=await callOllamaNative(input(),bad.deps);assert.equal(r.kind,'invalid_output');assert.equal(r.attempts,0);assert.equal(bad.calls.length,2);}
});
test('loopback literal endpoints only, no insecure TLS or redirects',async()=>{
 for(const url of ['https://127.0.0.1/api/chat','http://localhost/api/chat','http://127.1/api/chat','http://2130706433/api/chat','http://127.0.0.1/api/chat?x=1','http://user@127.0.0.1/api/chat','http://example.com/api/chat']){
  const s=stub();assert.equal((await callOllamaNative({...input(),endpoint:url},s.deps)).kind,'transport_error');assert.equal(s.calls.length,0);
  await assert.rejects(directLocalFetch(url));
 }
 const s=stub(()=>new Response('',{status:302,headers:{location:'http://example.com'}}));assert.equal((await callOllamaNative(input(),s.deps)).kind,'transport_error');assert.equal(s.calls.length,3);
});
test('caps, HTTP failures and broken streams never retry; partial raw retained',async()=>{
 const capped=stub(()=>new Response('x'.repeat(300000)));const r=await callOllamaNative(input(),capped.deps);
 assert.equal(r.kind,'invalid_output');assert.equal(capped.events.at(-1)?.complete,false);assert.equal(capped.events.at(-1)?.bytes.length,262144);assert.equal(capped.calls.length,3);
 const req=stub();assert.equal((await callOllamaNative({...input(),maxRequestBytes:1},req.deps)).kind,'invalid_output');assert.equal(req.calls.length,0);
 const broken=stub(()=>new Response(new ReadableStream({start(c){c.error(new Error('broken'));}})));
 assert.equal((await callOllamaNative(input(),broken.deps)).kind,'transport_error');assert.equal(broken.calls.length,3);
 const cap=stub();assert.equal((await callOllamaNative(input(),{...cap.deps,capture:()=>{throw Error('sink');}})).kind,'transport_error');assert.equal(cap.calls.length,0);
});
test('deadline covers identity and stalled body reads; cancellation is terminal',async()=>{
 for(const phase of ['identity','body']){
  const s=stub(()=>new Response(new ReadableStream({start(){}})));
  const deps=phase==='identity'?{...s.deps,fetch:async()=>new Promise<Response>(()=>{})}:s.deps;
  assert.equal((await callOllamaNative({...input(),deadlineMs:Date.now()+25},deps)).kind,'timeout');
 }
 const s=stub(),c=new AbortController();c.abort();assert.equal((await callOllamaNative({...input(),signal:c.signal},s.deps)).kind,'transport_error');assert.equal(s.calls.length,0);
});
test('native direct transport bypasses proxy environment (local HTTP stub, no model)',async()=>{
 const {createServer}=await import('node:http');
 const server=createServer((_req,res)=>{res.end('{"stub":true}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const keys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY'];
 const prior=keys.map(k=>process.env[k]);
 try {
  for(const k of keys)process.env[k]=k==='NODE_USE_ENV_PROXY'?'1':'http://127.0.0.1:1';
  const port=(server.address() as {port:number}).port;
  const response=await directLocalFetch(`http://127.0.0.1:${port}/api/tags`);
  assert.deepEqual(await response.json(),{stub:true});
 }finally{
  keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 }
});
