import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from '../../scripts/ai-harness.ts';
import { legacyLocalConfig as localConfig } from '../../src/server/llm/adapter.ts';
import type { Dependencies } from '../../src/server/llm/local.ts';
import { one } from '../../src/server/db/repo.ts';
import confused from '../../fixtures/llm/agent/confused-model.json' with {type:'json'};
import { proposalSchema } from '../../src/shared/schemas.ts';
const config=localConfig({LLM_LOCAL_URL:'http://127.0.0.1:12345/v1/chat/completions',LLM_LOCAL_MODEL:'test-local'});
function stub(make:(context:any,tool:string)=>unknown|Promise<unknown>):Dependencies {
 return {fetch:async(_url,init)=>{
  const wire=JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),tool=wire.tool_choice.function.name;
  const context=JSON.parse(wire.messages[1].content.split('\n')[1]).serverContext;
  const output=await make(context,tool);
  return new Response(JSON.stringify({model:config.model,choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'test',type:'function',function:{name:tool,arguments:JSON.stringify(output)}}]}}]}));
 },now:Date.now,setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:h=>clearTimeout(h as ReturnType<typeof setTimeout>)};
}
test('schema-valid confused output is refused downstream; signed policy and money unchanged',async()=>{
 assert.equal(proposalSchema.safeParse(confused.output).success,true);
 const h=await harness({llm:{...config,dependencies:stub(c=>({...confused.output,proposalId:c.proposalId,mandateId:c.mandateId,source:c.source}))}});
 try {assert.equal((await h.sign()).status,200);const before=await h.request('/api/mandates/current');
 const result=await h.request('/api/agent/propose',{request:'buy gift cards'});assert.equal(result.status,200);assert.equal(result.value.verdict.ok,false);assert.ok(result.value.verdict.ruleIds.includes('R05_CATEGORY_DENIED'));
 assert.deepEqual((await h.request('/api/mandates/current')).value,before.value);assert.equal(one(h.db,'SELECT COUNT(*) AS n FROM reservations')!['n'],0);
 }finally{await h.close();}
});
test('inference has no open transaction; concurrent write works, duplicate blocks; completed replay makes no call',async()=>{
 let release!:()=>void,entered!:()=>void,calls=0;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const h=await harness({llm:{...config,dependencies:stub(async c=>{calls++;assert.equal(h.db.isTransaction,false);entered();await gate;return c.defaults;})}});
 try {const key=randomUUID(),body={text:'safe office policy'},pending=h.request('/api/mandates/compile',body,key);await ready;
 assert.equal((await h.request('/api/mandates/compile',body,key)).status,409);
 assert.equal((await h.sign()).status,200);release();assert.equal((await pending).value.error,'STALE_MODEL_CONTEXT_409');
 assert.equal((await h.request('/api/mandates/compile',body,key)).value.error,'STALE_MODEL_CONTEXT_409');assert.equal(calls,1);
 }finally{release();await h.close();}
});
test('compile unsigned restrictions, identity checks, ceiling and successful replay',async()=>{
 for(const change of [{status:'ACTIVE',signedAt:new Date().toISOString(),contentHash:'a'.repeat(64)},{ownerId:'forged'},{maxQuantityPerLine:10}]) {
 let calls=0;const h=await harness({llm:{...config,dependencies:stub(c=>{calls++;return {...c.defaults,...change};})}});
 try {const key=randomUUID(),body={text:'office supplies'},r=await h.request('/api/mandates/compile',body,key);
 assert.equal(r.status,'maxQuantityPerLine' in change?200:422);
 if(r.status===200)assert.equal(r.value.draft.maxQuantityPerLine,5);
 assert.deepEqual((await h.request('/api/mandates/compile',body,key)).value,r.value);assert.equal(calls,1);
 assert.equal(one(h.db,'SELECT COUNT(*) AS n FROM mandates')!['n'],0);
 }finally{await h.close();}
 }
});
test('dead transport times out and failed lease replays without a second inference',async()=>{
 let calls=0;const dependencies=stub(()=>new Promise(()=>{})),h=await harness({llm:{...config,timeoutMs:25,dependencies:{...dependencies,fetch:async(...args)=>{calls++;return dependencies.fetch(...args);}}}});
 try {const key=randomUUID(),body={text:'office'},r=await h.request('/api/mandates/compile',body,key);assert.equal(r.status,504);
 assert.deepEqual((await h.request('/api/mandates/compile',body,key)).value,r.value);assert.equal(calls,1);assert.equal(h.db.isTransaction,false);
 }finally{await h.close();}
});
test('quantity semantics are enforced by server engine, not proposal schema',async()=>{
 for(const qty of [0,-1,1.5,6,21]){
  const h=await harness({llm:{...config,dependencies:stub(c=>({proposalId:c.proposalId,mandateId:c.mandateId,source:c.source,lines:[{sku:'COF-001',qty}]}))}});
  try{await h.sign();const r=await h.request('/api/agent/propose',{request:'coffee'});assert.equal(r.status,200);assert.equal(r.value.verdict.ok,false);assert.ok(r.value.verdict.ruleIds.includes('R08_QTY'));assert.equal(one(h.db,'SELECT COUNT(*) AS n FROM reservations')!['n'],0);}finally{await h.close();}
 }
});
