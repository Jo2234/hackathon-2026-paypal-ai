import { one } from '../../src/server/db/repo.ts';
import type { ModelResult } from '../../src/server/llm/adapter.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../../scripts/ai-harness.ts';
import { localConfig } from '../../src/server/llm/adapter.ts';
import { API_DIGEST, MODEL, PROMPT_VERSION } from '../../src/server/llm/narrow.ts';
import { nativeDependencies } from '../../src/server/llm/ollama-native.ts';
import { nativeCases, nativeReconcile, hash } from '../../scripts/ai-native-verdict.ts';
test('native real routes: all manifest oracles, parser replay, exclusion pairs and corruption rejection',async()=>{
 const corpus=readFileSync(new URL('../../fixtures/adversarial/descriptions.jsonl',import.meta.url),'utf8'),cases=nativeCases(corpus),config=localConfig({});
 const context={head:'a'.repeat(40),corpusSha256:hash(corpus),promptVersion:PROMPT_VERSION,model:MODEL,digest:API_DIGEST,endpoint:config.endpoint};
 const rows:any[]=[],wires=new Map<string,string>();
 for(const item of cases){const events:any[]=[],row:any={id:`${item.id}-0`,repetition:0,case:item,context,wire:item.id,resultCount:0,transportRequests:0,inferenceAttempts:0};
 const h=await harness({modelText:item.hostile?[JSON.stringify(item.hostile)]:[],llm:{...config,onContext:(c:Readonly<Record<string,unknown>>)=>row.authoritativeContext=c,onResult:(r:ModelResult)=>{row.resultCount++;row.validated=r;},dependencies:{...nativeDependencies(),fetch:async(url)=>{row.transportRequests++;let body:unknown;if(url.endsWith('/api/version'))body={version:'0.40.15'};else if(url.endsWith('/api/tags'))body={models:[{name:MODEL,digest:API_DIGEST}]};else{row.inferenceAttempts++;body={model:MODEL,done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(item.expected)}};}return new Response(JSON.stringify(body));},capture:e=>events.push({...e,bytes:undefined,base64:Buffer.from(e.bytes).toString('base64')})}}});
 try{assert.equal((await h.sign()).status,200);const before=(await h.request('/api/mandates/current')).value;
 const response=await h.request(item.task==='extraction'?'/api/mandates/compile':'/api/agent/propose',item.task==='extraction'?{text:item.text}:{request:item.text});row.status=response.status;row.serverDecision=response.value;row.signedStateUnchanged=JSON.stringify(before)===JSON.stringify((await h.request('/api/mandates/current')).value);
 const wire=events.map(e=>JSON.stringify(e)).join('\n')+'\n';row.wireSha256=hash(wire);wires.set(item.id,wire);rows.push(row);
 }finally{await h.close();}}
 const read=(p:string)=>wires.get(p)!;const gate=nativeReconcile(cases,1,rows,context,read);assert.equal(gate.pass,true,JSON.stringify(gate.entries.filter(e=>!e.pass)));
 for(const change of [(rs:any[])=>rs.pop(),(rs:any[])=>rs.push(rs[0]),(rs:any[])=>rs[0].wireSha256='x',(rs:any[])=>rs[0].case.expected.allowanceUSD=1,(rs:any[])=>rs[20].serverDecision.verdict.ok=false]){
 const altered=structuredClone(rows);change(altered);assert.equal(nativeReconcile(cases,1,altered,context,read).pass,false);
 }
});

test('complete late native body stays a timeout when route budget expires, without a false DB busy error', async () => {
  let wall = Date.now(), mono = 0, captured = false;
  const clock = { wallNow: () => wall, monotonicNow: () => mono };
  const h = await harness({clock, llm: {...localConfig({}), dependencies: {
    ...nativeDependencies(), now: () => wall,
    fetch: async url => {
      if (url.endsWith('/api/version')) return Response.json({version: '0.40.15'});
      if (url.endsWith('/api/tags')) return Response.json({models: [{name: MODEL, digest: API_DIGEST}]});
      // Simulate a suspension/scheduling gap, without claiming its historical cause.
      wall += 899460; mono += 899460;
      return Response.json({model: MODEL, done: true, done_reason: 'stop', message: {role: 'assistant', content: '{"sku":"COF-001","qty":1}'}});
    },
    capture: event => { if (event.phase === 'response' && event.complete && new TextDecoder().decode(event.bytes).includes('COF-001')) captured = true; },
  }}});
  try {
    assert.equal((await h.sign()).status, 200);
    const before = (await h.request('/api/mandates/current')).value;
    const result = await h.request('/api/agent/propose', {request: 'Buy 1 Ground coffee.'});
    assert.equal(captured, true);
    assert.equal(result.status, 504);
    assert.equal(result.value.error, 'MODEL_TIMEOUT_504');
    assert.equal(result.value.fixtureLabel, 'SIMULATED PAYPAL APPROVAL — FIXTURE (no PayPal calls)');
    assert.equal(result.value.mode.llm, 'local');
    assert.equal(result.value.mode.origin, 'live');
    assert.deepEqual((await h.request('/api/mandates/current')).value, before);
    assert.equal(one(h.db, 'SELECT COUNT(*) AS n FROM reservations')!['n'], 0);
    assert.equal(one(h.db, "SELECT state FROM idempotency_keys WHERE state='IN_PROGRESS'")!['state'], 'IN_PROGRESS');
    assert.equal(h.db.isTransaction, false);
  } finally { await h.close(); }
});
