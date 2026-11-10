import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { callHosted, directHostedFetch, HOSTED_ENDPOINT, HOSTED_MODEL } from '../../src/server/llm/hosted.ts';
import type { HostedRequest, Dependencies, Capture } from '../../src/server/llm/hosted.ts';
const key = 'synthetic_test_secret_123456789';
process.env.GROQ_API_KEY = key;
const good = () => ({model:HOSTED_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'call-1',type:'function',function:{name:'draft',arguments:'{"quantity":2}'}}]}}]});
const input = (extra = {}): HostedRequest<{quantity:number}> => ({endpoint:HOSTED_ENDPOINT,model:HOSTED_MODEL,
 tools:[{type:'function',function:{name:'draft',parameters:{type:'object'}}}],expectedTool:'draft',
 schema:{safeParse:(v:unknown)=>typeof v==='object' && v!==null && 'quantity' in v && v.quantity===2 ? {success:true,data:{quantity:2}} : {success:false}},
 messages:[{role:'user',content:'synthetic mandate'}],deadlineMs:Date.now()+2000,
 maxRequestBytes:65536,maxResponseBytes:4096,maxOutputTokens:256,...extra});
// Test seam redirects the already allow-listed logical URL to one owned loopback
// HTTP server. Production has no endpoint override and always uses direct TLS.
async function stub(body:unknown, status=200, extra={}, delay=0) {
 let hits=0;const captures:Capture[]=[];let authorization='';let redirect='';
 const server=createServer((req,res)=>{hits++;authorization=req.headers.authorization??'';req.resume();
  const send=()=>{if(res.destroyed)return;res.writeHead(status);res.end(typeof body==='string'?body:JSON.stringify(body));};
  if(delay)setTimeout(send,delay);else send();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const deps:Dependencies={now:Date.now,setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:h=>clearTimeout(h as NodeJS.Timeout),capture:e=>captures.push(e),
 fetch:async(url,init)=>{assert.equal(url,HOSTED_ENDPOINT);redirect=init.redirect??'';
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:address.port,method:'POST',headers:Object.fromEntries(new Headers(init.headers)),signal:init.signal??undefined,agent:false},res=>resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>,{status:res.statusCode??502})));req.on('error',reject);req.end(init.body);});}};
 try {const result=await callHosted(input(extra),deps);return {result,captures,hits,authorization,redirect};}
 finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
function noLeak(value:unknown){assert(!JSON.stringify(value).includes(key));}
test('valid native tool call; response identity, auth only on wire, one attempt',async()=>{
 const x=await stub(good());assert.equal(x.result.kind,'tool_call');assert.equal(x.result.model.returned,HOSTED_MODEL);
 assert.equal(x.authorization,`Bearer ${key}`);assert.equal(x.redirect,'error');assert.equal(x.hits,1);assert.equal(x.result.retries,0);noLeak(x.result);
 for(const c of x.captures){assert(!new TextDecoder().decode(c.bytes).includes(key));assert(!('headers' in c));}
});
test('non-allow-listed hosts and URL aliases rejected before network',async()=>{
 for(const endpoint of ['https://evil.test/openai/v1/chat/completions',HOSTED_ENDPOINT+'?x=1',HOSTED_ENDPOINT.replace('api.groq.com','api.groq.com.evil.test'),HOSTED_ENDPOINT.replace('https:','http:'),HOSTED_ENDPOINT.replace('api.groq.com','api.groq.com:443')]){
 const x=await stub(good(),200,{endpoint});assert.equal(x.result.kind,'transport_error');assert.equal(x.hits,0);}
 await assert.rejects(directHostedFetch('https://evil.test',{redirect:'error'}),/HOSTED_ENDPOINT_REJECTED/);
});
for(const status of [429,401,403])test(`HTTP ${status} typed and never retried or fixtures`,async()=>{
 const x=await stub({error:key},status);assert.equal(x.result.kind,status===429?'quota_error':'auth_error');assert.equal(x.hits,1);noLeak(x.result);noLeak(x.captures);});
test('truncation finish reason',async()=>{const b=good();b.choices[0]!.finish_reason='length';const x=await stub(b);assert.equal(x.result.kind,'invalid_output');});
test('wrong tool',async()=>{const b=good();b.choices[0]!.message.tool_calls[0]!.function.name='pay';const x=await stub(b);assert.equal(x.result.kind,'invalid_output');if(x.result.kind==='invalid_output')assert.equal(x.result.reason,'wrong_tool');});
test('bad envelope JSON',async()=>{const x=await stub('{');assert.equal(x.result.kind,'invalid_output');});
test('bad arguments JSON and wrong schema',async()=>{for(const args of ['{','{"quantity":-1}']){const b=good();b.choices[0]!.message.tool_calls[0]!.function.arguments=args;assert.equal((await stub(b)).result.kind,'invalid_output');}});
test('byte caps and incomplete capture',async()=>{const x=await stub('a'.repeat(9000));assert.equal(x.result.kind,'invalid_output');const c=x.captures.find(e=>e.phase==='response');assert(c);assert.equal(c.complete,false);assert.equal(new TextDecoder().decode(c.bytes),'[REDACTED_SECRET_BODY]');
 const y=await stub(good(),200,{maxRequestBytes:1});assert.equal(y.hits,0);assert.equal(y.result.kind,'invalid_output');});
test('deadline includes body transport',async()=>{const x=await stub(good(),200,{deadlineMs:Date.now()+50},150);assert.equal(x.result.kind,'timeout');});
test('echoed secrets redacted from capture and rejected from result, including unicode escapes',async()=>{
 for(const text of [JSON.stringify({...good(),echo:key}),JSON.stringify({...good(),echo:key}).replace(key,[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''))]){
 const x=await stub(text);assert.equal(x.result.kind,'invalid_output');noLeak(x.result);for(const c of x.captures)assert(!new TextDecoder().decode(c.bytes).includes(key));}
});
test('transport errors never expose thrown credential',async()=>{
 const d:Dependencies={fetch:async()=>{throw Error(key);},now:Date.now,setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:h=>clearTimeout(h as NodeJS.Timeout)};
 const r=await callHosted(input(),d);assert.equal(r.kind,'transport_error');noLeak(r);
});
test('missing credential fails closed',async()=>{delete process.env.GROQ_API_KEY;try{const x=await stub(good());assert.equal(x.hits,0);assert.equal(x.result.kind,'transport_error');}finally{process.env.GROQ_API_KEY=key;}});
test('capture failure fails closed',async()=>{const d:Dependencies={fetch:async()=>{throw Error('must not fetch');},now:Date.now,setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:h=>clearTimeout(h as NodeJS.Timeout),capture:()=>{throw Error(key);}};const r=await callHosted(input(),d);assert.equal(r.kind,'transport_error');noLeak(r);});

test('missing, multiple calls and model mismatch fail closed',async()=>{
 const missing=good();missing.choices[0]!.message.tool_calls=[];
 const multiple=good();multiple.choices[0]!.message.tool_calls.push(multiple.choices[0]!.message.tool_calls[0]!);
 const mismatch=good();mismatch.model='different-model';
 for(const body of [missing,multiple,mismatch]){
  const x=await stub(body);assert.equal(x.result.kind,'invalid_output');assert.equal(x.hits,1);
  if(body===mismatch)assert.equal(x.result.model.returned,'different-model');
 }
});
test('ordinary capture preserves exact raw response bytes',async()=>{
 const raw=JSON.stringify(good(),null,2)+'\n';const x=await stub(raw);
 assert.equal(new TextDecoder().decode(x.captures.find(e=>e.phase==='response')!.bytes),raw);
});

for (const encoding of ['unicode', 'nested', 'base64', 'case', 'property', 'deep']) test(`decoded secret boundary: ${encoding}`, async () => {
 const b = good();
 const escaped = [...key].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
 let value = encoding === 'base64' ? Buffer.from(key).toString('base64') : encoding === 'case' ? key.toUpperCase() : key;
 if (encoding === 'nested') value = JSON.stringify({hidden: JSON.stringify({hidden:key})}).replace(key, escaped);
 if (encoding === 'deep') for (let i=0;i<16;i++) value=JSON.stringify({hidden:value});
 b.choices[0]!.message.tool_calls[0]!.function.arguments = encoding === 'property' ? JSON.stringify({[key]:2}) : JSON.stringify({quantity:2, hidden:value});
 if (encoding === 'unicode') b.choices[0]!.message.tool_calls[0]!.function.arguments = '{"quantity":2,"hidden":"' + escaped + '"}';
 const x = await stub(b,200,{maxResponseBytes:2_000_000});
 assert.equal(x.result.kind,'invalid_output');
 if (x.result.kind==='invalid_output') assert.equal(x.result.reason,'secret_in_response');
 assert.equal(x.result.model.returned,null);
 assert.equal(new TextDecoder().decode(x.captures.find(c=>c.phase==='response')!.bytes),'[REDACTED_SECRET_BODY]');
});

test('TLS bypass settings refuse before capture or transport',async()=>{
 const {readModes}=await import('../../src/server/env.ts');
 const {globalAgent}=await import('node:https');
 const globals=globalThis as unknown as Record<symbol,unknown>;
 const symbol=Symbol.for('undici.globalDispatcher.1');
 const previous=globals[symbol], tls=process.env.NODE_TLS_REJECT_UNAUTHORIZED, agent=globalAgent.options.rejectUnauthorized;
 let calls=0,captures=0;
 const deps:Dependencies={fetch:async()=>{calls++;return new Response(JSON.stringify(good()));},now:Date.now,setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:h=>clearTimeout(h as NodeJS.Timeout),capture:()=>{captures++;}};
 try{
  for(const mode of ['environment','https-agent','dispatcher','connector']){
   if(mode==='environment')process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
   if(mode==='https-agent')globalAgent.options.rejectUnauthorized=false;
   if(mode==='dispatcher')globals[symbol]={[Symbol('options')]:{connect:{rejectUnauthorized:false}}};
   if(mode==='connector')globals[symbol]={[Symbol('options')]:{connect:()=>{}}};
   for(const setting of [{LLM_MODE:'hosted'},{PAYPAL_MODE:'sandbox'}])assert.throws(()=>readModes({...process.env,...setting}),/TLS_VERIFICATION_REQUIRED/);
   const r=await callHosted(input(),deps);assert.equal(r.kind,'transport_error');
   if(r.kind==='transport_error')assert.equal(r.reason,'tls_verification_required');
   await assert.rejects(directHostedFetch(HOSTED_ENDPOINT,{redirect:'error'}),/TLS_VERIFICATION_REQUIRED/);
   if(tls===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=tls;
   globalAgent.options.rejectUnauthorized=agent;globals[symbol]=previous;
  }
  assert.equal(calls,0);assert.equal(captures,0);
 }finally{
  if(tls===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=tls;
  globalAgent.options.rejectUnauthorized=agent;globals[symbol]=previous;
 }
});
