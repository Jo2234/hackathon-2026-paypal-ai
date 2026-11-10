import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { harness } from '../../scripts/ai-harness.ts';
import { hostedConfig } from '../../src/server/llm/adapter.ts';
import { readModes } from '../../src/server/env.ts';
import { HOSTED_ENDPOINT, HOSTED_MODEL } from '../../src/server/llm/hosted.ts';
import type { Dependencies } from '../../src/server/llm/hosted.ts';
const key='synthetic_integration_secret';
const env={LLM_MODE:'hosted',LLM_HOSTED_PROVIDER:'groq',LLM_HOSTED_URL:HOSTED_ENDPOINT,LLM_HOSTED_FREE_CONFIRMED:'yes',GROQ_API_KEY:key};
process.env['GROQ_API_KEY']=key;
test('startup validates required settings without values; model defaults; no credential in config',()=>{
 assert.equal(hostedConfig(env).model,HOSTED_MODEL);
 assert.ok(!JSON.stringify(hostedConfig(env)).includes(key));
 for(const field of ['LLM_HOSTED_PROVIDER','LLM_HOSTED_URL','LLM_HOSTED_FREE_CONFIRMED','GROQ_API_KEY']){
  assert.throws(()=>readModes({...env,[field]:undefined}),/^Error: HOSTED_MODEL_CONFIGURATION_REQUIRED$/);
 }
 assert.throws(()=>hostedConfig({...env,LLM_HOSTED_URL:'https://evil.test'}),/HOSTED_MODEL_CONFIGURATION_REQUIRED/);
 assert.throws(()=>hostedConfig({...env,LLM_HOSTED_MODEL:'other'}),/HOSTED_MODEL_CONFIGURATION_REQUIRED/);
});
async function setup(status=200,echo=false, secretEncoding='') {
 let hits=0;const evidence:string[]=[];
 const server=createServer(async(req,res)=>{
  hits++;assert.equal(req.headers.authorization,`Bearer ${key}`);
  let bytes='';for await(const chunk of req)bytes+=chunk;
  const wire=JSON.parse(bytes),c=JSON.parse(wire.messages[1].content.split('\n')[1]).serverContext;
  assert.ok(!bytes.includes('demo-owner'));assert.ok(!bytes.includes('test-mandate'));assert.ok(!bytes.includes('demo-merchant'));
  assert.ok(!bytes.includes('/no_think'));assert.ok(!bytes.includes('periodKey'));
  const tool=wire.tool_choice.function.name,args=tool==='compile_policy'?c.defaults:{proposalId:c.proposalId,mandateId:c.mandateId,source:c.source,lines:[{sku:'GFT-050',qty:1}]};
  res.writeHead(status,status===302?{location:'https://evil.test'}:{});
  let argumentText=JSON.stringify(args);
  if(secretEncoding){
   const value=secretEncoding==='base64'?Buffer.from(key).toString('base64'):secretEncoding==='case'?key.toUpperCase():key;
   argumentText=JSON.stringify({...args,lines:[{sku:value,qty:1}]});
   if(secretEncoding==='unicode')argumentText=argumentText.replace(key,[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  }
  res.end(JSON.stringify({model:HOSTED_MODEL,...(echo?{echo:key}:{}),choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'stub',type:'function',function:{name:tool,arguments:argumentText}}]}}]}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert(address&&typeof address!=='string');
 const dependencies:Dependencies={now:Date.now,setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:h=>clearTimeout(h as NodeJS.Timeout),capture:e=>evidence.push(new TextDecoder().decode(e.bytes)),fetch:async(url,init)=>{
  assert.equal(url,HOSTED_ENDPOINT);assert.equal(init.redirect,'error');
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:address.port,method:'POST',agent:false,headers:Object.fromEntries(new Headers(init.headers)),signal:init.signal??undefined},res=>resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>,{status:res.statusCode??502})));req.on('error',reject);req.end(init.body);});
 }};
 const h=await harness({llm:{...hostedConfig(env),dependencies}});
 return {h,evidence,hits:()=>hits,close:async()=>{await h.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
test('hosted draft remains unsigned; proposal denied by engine; returned provenance and replay',async()=>{
 const x=await setup();try{
  const r=await x.h.request('/api/mandates/compile',{text:'synthetic office supplies'});
  assert.equal(r.status,200);assert.equal(r.value.draft.status,'DRAFT');assert.equal(r.value.draft.signedAt,null);
  assert.equal(r.value.draft.ownerId,'demo-owner');assert.equal(r.value.compiledBy.mode,'hosted');assert.equal(r.value.compiledBy.model,HOSTED_MODEL);
  assert.deepEqual(r.value.modelProvenance,{mode:'hosted',provider:'groq',model:HOSTED_MODEL,identity:'returned'});
  assert.equal(x.h.db.prepare('SELECT COUNT(*) n FROM mandates').get()!['n'],0);
  await x.h.sign();const before=(await x.h.request('/api/mandates/current')).value;
  const id=randomUUID(),body={request:'synthetic gift card'},p=await x.h.request('/api/agent/propose',body,id);
  assert.equal(p.status,200);assert.equal(p.value.proposal.source.mode,'hosted');assert.equal(p.value.verdict.ok,false);
  assert.deepEqual((await x.h.request('/api/agent/propose',body,id)).value,p.value);assert.equal(x.hits(),2);
  assert.deepEqual((await x.h.request('/api/mandates/current')).value,before);
  assert.equal(x.h.db.prepare('SELECT COUNT(*) n FROM reservations').get()!['n'],0);
 }finally{await x.close();}
});
for(const [status,echo,code] of [[429,false,'MODEL_QUOTA_429'],[401,false,'MODEL_AUTH_503'],[302,false,'MODEL_UNAVAILABLE_503'],[200,true,'MODEL_UNAVAILABLE_503']] as const)test(`failure ${status}/${echo}: no fallback, replay, key absent from response, DB and evidence`,async()=>{
 const x=await setup(status,echo);try{
  const id=randomUUID(),body={text:'synthetic office'},r=await x.h.request('/api/mandates/compile',body,id);
  assert.equal(r.value.error,code);assert.equal(r.value.mode.llm,'hosted');assert.equal(r.value.draft,undefined);
  assert.deepEqual((await x.h.request('/api/mandates/compile',body,id)).value,r.value);assert.equal(x.hits(),1);
  const db=x.h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>x.h.db.prepare(`SELECT * FROM "${row['name']}"`).all());
  for(const value of [r.value,db,x.evidence])assert.ok(!JSON.stringify(value).includes(key));
 }finally{await x.close();}
});

// Run the real provider-neutral runner. Redirect only the node:https test seam to
// owned loopback HTTP; production retains its literal TLS endpoint and transport.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for(const status of [200,302,429])test(`hosted live-runner stub ${status}: strict corpus gate and no secret in logs/evidence`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hosted-runner-'));let calls=0;
 const server=createServer(async(req,res)=>{
  calls++;let raw='';for await(const chunk of req)raw+=chunk;
  const wire=JSON.parse(raw),c=JSON.parse(wire.messages[1].content.split('\n')[1]).serverContext,tool=wire.tool_choice.function.name;
  const args=tool==='compile_policy'?c.defaults:{proposalId:c.proposalId,mandateId:c.mandateId,source:c.source,lines:[{sku:'COF-001',qty:1}]};
  res.writeHead(status,status===302?{location:'https://evil.test'}:{});
  res.end(status===200?JSON.stringify({model:HOSTED_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'stub',type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}}]}):key);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');
 const hook=join(dir,'transport.mjs');
 // An archive has no .git. Explicit synthetic test provenance, like the local
 // runner regressions; never represent these stub records as live acceptance.
 await writeFile(hook,`import https from 'node:https';import http from 'node:http';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const exec=cp.execFileSync;cp.execFileSync=(cmd,args,...rest)=>cmd==='git'&&args.join(' ')==='rev-parse HEAD'?'0000000000000000000000000000000000000000\\n':exec(cmd,args,...rest);
https.request=(options,callback)=>{if(options.hostname!=='api.groq.com'||options.path!=='/openai/v1/chat/completions'||options.port!==443||options.agent!==false)throw Error('BAD_TRANSPORT');return http.request({...options,hostname:'127.0.0.1',port:${address.port}},callback);};syncBuiltinESMExports();`);
 try{
  const child=spawn(process.execPath,['--import',hook,'scripts/test-ai-live.ts'],{env:{...process.env,...env,AI_LIVE_EVIDENCE_DIR:dir,AI_LIVE_EXCLUSIVE_RUNTIME:'1',AI_LIVE_REPETITIONS:'3',AI_LIVE_IDENTITY_URL:undefined},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  const exit=await new Promise(r=>child.once('exit',r));clearTimeout(timer);
  assert.equal(exit,status===200?0:1,output);assert.equal(calls,141);
  const files=await readdir(dir),manifest=JSON.parse(await readFile(join(dir,files.find(f=>f.endsWith('-manifest.json'))!),'utf8'));
  assert.equal(manifest.verdict,status===200?'PASS':'FAIL');
  assert.equal(manifest.context.mode,'hosted');assert.equal(manifest.summary.normalCasesPass,status===200);
  if(status===200){assert.equal(manifest.summary.evaluatedInference,141);
   // A response with forged metadata or missing context cannot satisfy the gate.
   const { reconcile, sha256 }=await import('../../scripts/ai-live-verdict.ts');
   const rows=manifest.attempts;
    // Reviewer mutations keep the retained result/decision fixed and recompute
    // the wire hash, so only replay through the production parser can reject.
    const mutationResults:boolean[]=[];
    for(const mutation of ['refusal-plus-tool','role-changed','type-changed']) {
      const row=rows[2],raw=requireRead(row.wire),events=raw.trim().split('\n').map((s:string)=>JSON.parse(s));
      const body=JSON.parse(Buffer.from(events[1].base64,'base64').toString('utf8'));
      const message=body.choices[0].message;
      if(mutation==='refusal-plus-tool')message.refusal='I cannot comply';
      if(mutation==='role-changed')message.role='user';
      if(mutation==='type-changed')message.tool_calls[0].type='not-function';
      events[1].base64=Buffer.from(JSON.stringify(body)).toString('base64');
      const changedWire=events.map((e:unknown)=>JSON.stringify(e)).join('\n')+'\n';
      const changedRows=rows.map((r:any,i:number)=>i===2?{...r,wireSha256:sha256(changedWire)}:r);
      mutationResults.push(reconcile(manifest.expectedCases,changedRows,manifest.context,p=>p===row.wire?changedWire:requireRead(p)).pass);
    }
    assert.deepEqual(mutationResults,[false,false,false],'refusal-plus-tool, role-changed, type-changed');

   for(const patch of [{authoritativeContext:undefined},{serverDecision:{}},{resultCount:0}])assert.equal(reconcile(manifest.expectedCases,[{...rows[0],...patch},...rows.slice(1)],manifest.context,p=>requireRead(p)).pass,false);
  }
  assert.ok(!output.includes(key));
  for(const f of files)assert.ok(!(await readFile(join(dir,f),'utf8')).includes(key),f);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
import { readFileSync } from 'node:fs';
const requireRead=(path:string)=>readFileSync(path,'utf8');

for(const encoding of ['unicode','plain','base64','case'])test(`proposal secret ${encoding}: no API, database or recoverable capture disclosure`,async()=>{
 const x=await setup(200,false,encoding);
 try{
  await x.h.sign();
  const r=await x.h.request('/api/agent/propose',{request:'one coffee'});
  assert.equal(r.status,503);assert.equal(r.value.error,'MODEL_UNAVAILABLE_503');
  assert.equal(r.value.proposal,undefined);
  const rows=x.h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>x.h.db.prepare(`SELECT * FROM "${row['name']}"`).all());
  for(const v of [r.value,rows])assert.ok(!JSON.stringify(v).toLowerCase().includes(key.toLowerCase()));
  assert.equal(x.evidence.at(-1),'[REDACTED_SECRET_BODY]');
  assert.equal(x.h.db.prepare('SELECT COUNT(*) n FROM reservations').get()!['n'],0);
 }finally{await x.close();}
});
