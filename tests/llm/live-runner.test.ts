import { readFileSync as requireWireBytes } from 'node:fs';
const requireWire=(path:string)=>requireWireBytes(path,'utf8');
import { reconcile, sha256 } from '../../scripts/ai-live-verdict.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('live runner fails closed with zero inference through real routes',async()=>{
 let completions=0;
 const server=http.createServer((req,res)=>{if(req.url==='/identity')res.end(JSON.stringify({model:'offline-stub',digest:'a'.repeat(64)}));else{completions++;res.writeHead(500);res.end('{}');}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const dir=await mkdtemp(join(tmpdir(),'ai-negative-'));
 try{
  const child=spawn(process.execPath,['scripts/test-ai-full.ts'],{env:{...process.env,AI_LIVE_EVIDENCE_DIR:dir,LLM_LOCAL_URL:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1/chat/completions`,AI_LIVE_IDENTITY_URL:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/identity`,LLM_LOCAL_MODEL:'offline-stub',LLM_LOCAL_PROMPT_SUFFIX:'X'.repeat(70000),AI_LIVE_EXCLUSIVE_RUNTIME:'1',AI_LIVE_REPETITIONS:'3'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const exit=await new Promise(r=>child.on('exit',r));
  assert.notEqual(exit,0,`Zero inference must not pass: ${output}`);
  assert.equal(completions,0);
  const files=await readdir(dir);const manifest=JSON.parse(await readFile(join(dir,files.find(f=>f.endsWith('-manifest.json'))!), 'utf8'));
  assert.equal(manifest.verdict,'UNRUN');assert.equal(manifest.summary.transportAttempts,0);assert.equal(manifest.summary.n,141);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('live runner rejects hostile HTTP failures even when every normal inference succeeds',async()=>{
 let completions=0,failures=0;
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/identity'){res.end(JSON.stringify({model:'offline-stub',digest:'a'.repeat(64)}));return;}
  let bytes='';for await(const chunk of req)bytes+=chunk;
  const wire=JSON.parse(bytes),context=JSON.parse(wire.messages[1].content.split('\n')[1]).serverContext;
  const normal=completions++%47<2;
  if(!normal){failures++;res.writeHead(500);res.end('{}');return;}
  const tool=wire.tool_choice.function.name,args=tool==='compile_policy'?context.defaults:{proposalId:context.proposalId,mandateId:context.mandateId,source:context.source,lines:[{sku:'COF-001',qty:1}]};
  res.end(JSON.stringify({model:'offline-stub',choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'stub',type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}}]}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const dir=await mkdtemp(join(tmpdir(),'ai-hostile-negative-'));
 try{
  const child=spawn(process.execPath,['scripts/test-ai-full.ts'],{env:{...process.env,AI_LIVE_EVIDENCE_DIR:dir,LLM_LOCAL_URL:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1/chat/completions`,AI_LIVE_IDENTITY_URL:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/identity`,LLM_LOCAL_MODEL:'offline-stub',LLM_LOCAL_PROMPT_SUFFIX:'',AI_LIVE_EXCLUSIVE_RUNTIME:'1',AI_LIVE_REPETITIONS:'3'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const exit=await new Promise(r=>child.on('exit',r));
  const files=await readdir(dir),manifest=JSON.parse(await readFile(join(dir,files.find(f=>f.endsWith('-manifest.json'))!),'utf8'));
  assert.equal(completions,141);assert.equal(failures,135);
  assert.equal(manifest.summary.normalCasesPass,true);assert.equal(manifest.summary.schemaValid,6);
  assert.equal(manifest.summary.completedResponses,141);
  assert.notEqual(exit,0,`Hostile HTTP500 must fail: ${output}`);
  assert.equal(manifest.verdict,'FAIL');assert.ok(manifest.reasons.includes('INFERENCE_OUTCOME_FAILED'));
  assert.equal(manifest.summary.perClass.hostile.failureRate,1);assert.equal(manifest.summary.perClass.compile.passRate,1);
  assert.equal(manifest.summary.inferenceFailures,135);assert.equal(manifest.summary.transportErrors,135);assert.equal(manifest.summary.evaluatedInference,6);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

// Every scenario executes the actual runner, actual app routes, SQLite and HTTP adapter.
// The preload corrupts corpus input and supplies explicit synthetic test provenance
// for source exports without .git; it never replaces routes or inference.
for (const scenario of ['missing-corpus','duplicate-corpus','extra-corpus','changed-corpus','truncated-refusal','missing-finish','unknown-finish','wrong-model','invalid-schema','missing-head','complete-refusal','complete-tools','four-repetitions','digest-mismatch','digest-prefix','no-metadata','hostile-rejected','capped-draft']) {
 test(`manifest gate: ${scenario}`, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-manifest-'));
  const hook=join(dir,'corpus-hook.mjs');
  await writeFile(hook,`import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const exec=cp.execFileSync; cp.execFileSync=(cmd,args,...rest)=>{
 if(cmd==='git'&&args.join(' ')==='rev-parse HEAD'){
  if(${JSON.stringify(scenario)}==='missing-head')throw new Error('regression: no HEAD');
  return '0000000000000000000000000000000000000000\\n';
 }
 return exec(cmd,args,...rest);
};
const read=fs.readFileSync; fs.readFileSync=(path,...args)=>{const raw=read(path,...args);
if(!String(path).endsWith('/fixtures/adversarial/descriptions.jsonl')) return raw;
const rows=String(raw).trim().split('\\n'); const scenario=${JSON.stringify(scenario)};
if(scenario==='missing-corpus')rows.shift();
if(scenario==='duplicate-corpus')rows[1]=rows[0];
if(scenario==='extra-corpus')rows.push(JSON.stringify({...JSON.parse(rows[0]),id:'ADV-999'}));
if(scenario==='changed-corpus')rows[0]=JSON.stringify({...JSON.parse(rows[0]),description:'changed'});
return rows.join('\\n')+'\\n';};syncBuiltinESMExports();`);
  let completions=0;
  const server=http.createServer(async(req,res)=>{
   if(req.url==='/identity'){res.end(JSON.stringify({model:'offline-stub',digest:'a'.repeat(64)}));return;}
   let bytes='';for await(const chunk of req)bytes+=chunk;
   const wire=JSON.parse(bytes),context=JSON.parse(wire.messages[1].content.split('\n')[1]).serverContext;
   const hostile=completions++%47>=2,tool=wire.tool_choice.function.name;
   const args=tool==='compile_policy'?{...context.defaults,...(scenario==='capped-draft'?{allowanceMinor:12000,perOrderMaxMinor:10000,maxQuantityPerLine:20}:{})}:{proposalId:context.proposalId,mandateId:context.mandateId,source:context.source,lines:[{sku:hostile&&scenario==='hostile-rejected'?'GFT-050':'COF-001',qty:1}]};
   const refusal=hostile&&['truncated-refusal','missing-finish','unknown-finish','complete-refusal'].includes(scenario);
   const finish=scenario==='truncated-refusal'?'length':scenario==='missing-finish'?undefined:scenario==='unknown-finish'?'future':'stop';
   res.end(JSON.stringify({model:hostile&&scenario==='wrong-model'?'other':'offline-stub',choices:[{finish_reason:refusal?finish:'tool_calls',message:refusal?{role:'assistant',refusal:'I cannot comply'}:{role:'assistant',tool_calls:[{id:'stub',type:'function',function:{name:tool,arguments:JSON.stringify(hostile&&scenario==='invalid-schema'?{}:args)}}]}}]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
   const child=spawn(process.execPath,['--import',hook,'scripts/test-ai-full.ts'],{env:{...process.env,AI_LIVE_EVIDENCE_DIR:dir,LLM_LOCAL_URL:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1/chat/completions`,LLM_LOCAL_MODEL:'offline-stub',LLM_LOCAL_PROMPT_SUFFIX:'',AI_LIVE_EXCLUSIVE_RUNTIME:'1',LLM_LOCAL_DIGEST:scenario==='digest-mismatch'?'b'.repeat(64):scenario==='digest-prefix'?'sha256:'+'a'.repeat(64):undefined,AI_LIVE_IDENTITY_URL:scenario==='no-metadata'?undefined:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/identity`,AI_LIVE_REPETITIONS:scenario==='four-repetitions'?'4':'3'},stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
   const exit=await new Promise(r=>child.on('exit',r));clearTimeout(timer);
   const pass=['complete-refusal','complete-tools','four-repetitions','digest-prefix','no-metadata','hostile-rejected','capped-draft'].includes(scenario);
   assert.equal(exit,pass?0:1,output);
   const files=await readdir(dir),file=files.find(f=>f.endsWith('-manifest.json'));
   assert.ok(file,'Every run must retain its gate result');
   const manifest=JSON.parse(await readFile(join(dir,file),'utf8'));
   assert.equal(manifest.verdict,pass?'PASS':'FAIL');
   if(pass){
    const repeat=scenario==='four-repetitions'?4:3;
    assert.equal(completions,47*repeat);
    assert.equal(manifest.expectedCases.length,47*repeat);
    assert.equal(manifest.summary.perClass.compile.passed,repeat);
    assert.equal(manifest.summary.perClass.proposal.passed,repeat);
    assert.equal(manifest.summary.perClass.hostile.passed,45*repeat);
    assert.equal(manifest.summary.perClass.hostile.passRate,1);
    // Reconcile real-runner records, including equal-cardinality substitutions.
    const expected=manifest.expectedCases,rows=manifest.attempts;
if(scenario==='complete-tools'){
    // Reviewer mutations keep the retained result/decision fixed and recompute
    // the wire hash, so only replay through the production parser can reject.
    const mutationResults:boolean[]=[];
    for(const mutation of ['refusal-plus-tool','role-changed','type-changed']) {
      const row=rows[2],raw=requireWire(row.wire),events=raw.trim().split('\n').map((s:string)=>JSON.parse(s));
      const body=JSON.parse(Buffer.from(events[1].base64,'base64').toString('utf8'));
      const message=body.choices[0].message;
      if(mutation==='refusal-plus-tool')message.refusal='I cannot comply';
      if(mutation==='role-changed')message.role='user';
      if(mutation==='type-changed')message.tool_calls[0].type='not-function';
      events[1].base64=Buffer.from(JSON.stringify(body)).toString('base64');
      const changedWire=events.map((e:unknown)=>JSON.stringify(e)).join('\n')+'\n';
      const changedRows=rows.map((r:any,i:number)=>i===2?{...r,wireSha256:sha256(changedWire)}:r);
      mutationResults.push(reconcile(manifest.expectedCases,changedRows,manifest.context,p=>p===row.wire?changedWire:requireWire(p)).pass);
    }
    assert.deepEqual(mutationResults,[false,false,false],'refusal-plus-tool, role-changed, type-changed');
}

    const rejected=(records:typeof rows)=>assert.equal(reconcile(expected,records,manifest.context,path=>requireWire(path)).pass,false);
    rejected(rows.map((r: any)=>({...r,serverDecision:{mode:r.serverDecision.mode}})));
    rejected(rows.map((r: any)=>({...r,serverDecision:{...r.serverDecision,verdict:undefined}})));
    rejected(rows.map((r: any)=>({...r,serverDecision:{...r.serverDecision,draft:{unrelated:true},proposal:{proposalId:'unrelated',lines:[{sku:'GFT-050',qty:999}]},verdict:{ok:true}}})));
    for(const key of Object.keys(manifest.context))rejected(rows.map((r:any)=>({...r,context:{...r.context,[key]:'other-run-or-artifact'}})));
    rejected(rows.map((r:any)=>({...r,wireSha256:'0'.repeat(64)})));
    rejected(rows.map((r:any)=>({...r,wire:'/missing/wire'})));
    rejected(rows.map((r:any)=>({...r,serverDecision:{...r.serverDecision,mode:{...r.serverDecision.mode,digest:'b'.repeat(64)}}})));
    const changed=(index:number,patch:any)=>rejected(rows.map((r:any,i:number)=>i===index?{...r,serverDecision:{...r.serverDecision,...patch}}:r));
    changed(0,{draft:{...rows[0].serverDecision.draft,mandateId:'unrelated'}});
    changed(0,{draft:{...rows[0].serverDecision.draft,allowanceMinor:1}});
    changed(1,{verdict:undefined});
    changed(1,{verdict:{ok:true}});
    changed(1,{proposal:{...rows[1].serverDecision.proposal,proposalId:'unrelated'}});
    changed(1,{proposal:{...rows[1].serverDecision.proposal,lines:[{sku:'GFT-050',qty:999}]}});
    changed(1,{verdict:{...rows[1].serverDecision.verdict,proposalId:'unrelated'}});
    rejected(rows.slice(1));
    rejected([...rows,rows[0]]);
    rejected([rows[0],...rows.slice(2),rows[0]]);
    rejected([...rows,{...rows[0],id:'unexpected'}]);
    for(const patch of [{repetition:99},{case:{...rows[0].case,text:'changed'}},{resultCount:0},{resultCount:2},{completion:undefined},{serverDecision:{}},{status:500},{signedStateUnchanged:false},{error:'setup failed'},{transportAttempts:0},{completedResponses:0},{validatedToolCall:undefined}]){
     rejected([{...rows[0],...patch},...rows.slice(1)]);
    }

   }
   if(scenario==='digest-mismatch'){assert.equal(completions,0);assert.equal(manifest.config.assertedDigest,'b'.repeat(64));assert.equal(manifest.identity.digest,'a'.repeat(64));}
   if(scenario==='hostile-rejected')assert.ok(manifest.attempts.filter((r:any)=>r.case.hostile).every((r:any)=>r.serverDecision.verdict.ok===false));
   if(scenario==='missing-head')assert.deepEqual(manifest.reasons,['HEAD_UNAVAILABLE']);
   if(scenario.endsWith('corpus'))assert.equal(completions,0,'Reject altered corpus before inference');
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
 });
}
