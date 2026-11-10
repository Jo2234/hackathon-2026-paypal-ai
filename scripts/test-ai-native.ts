import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { harness } from './ai-harness.ts';
import { localConfig } from '../src/server/llm/adapter.ts';
import { nativeDependencies } from '../src/server/llm/ollama-native.ts';
import { PROMPT_VERSION, MODEL, API_DIGEST } from '../src/server/llm/narrow.ts';
import { nativeCases, nativeReconcile, hash } from './ai-native-verdict.ts';
export async function runNative(){
 if(process.env['AI_LIVE_EXCLUSIVE_RUNTIME']!=='1'||process.env['PAYPAL_MODE']!=='fixture')throw Error('EXCLUSIVE_RUNTIME_AND_FIXTURE_REQUIRED');
 const repeat=Number(process.env['AI_LIVE_REPETITIONS']??3);if(!Number.isInteger(repeat)||repeat<3||repeat>10)throw Error('REPETITIONS');
 const dir=process.env['AI_LIVE_EVIDENCE_DIR']??new URL('../../evidence/ai-live/',import.meta.url).pathname;mkdirSync(dir,{recursive:true});
 const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID(),config=localConfig(process.env);
 const corpus=readFileSync(new URL('../fixtures/adversarial/descriptions.jsonl',import.meta.url),'utf8'),cases=nativeCases(corpus);
 const context={version:'native-narrow-v1',runId,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),corpusSha256:hash(corpus),promptVersion:PROMPT_VERSION,model:MODEL,digest:API_DIGEST,endpoint:config.endpoint};
 const report:any={verdict:'UNRUN',context,retries:0,startedAt:new Date().toISOString(),expectedCases:cases,repetitions:repeat,attempts:[],paypal:'fixture; no PayPal calls'};
 const save=()=>writeFileSync(`${dir}/${runId}-manifest.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
 writeFileSync(`${dir}/${runId}-corpus.jsonl`,corpus,{mode:0o600});
 for(let repetition=0;repetition<repeat;repetition++)for(const item of cases){
 const id=`${item.id}-${repetition}`,wire=`${dir}/${runId}-${id}-wire.jsonl`,row:any={id,repetition,case:item,context,wire,resultCount:0,transportRequests:0,inferenceAttempts:0,status:0,signedStateUnchanged:false};
 const deps=nativeDependencies();const h=await harness({llm:{...config,onContext:(c:Readonly<Record<string,unknown>>)=>{row.authoritativeContext=c;},onResult:r=>{row.resultCount++;row.validated=r;},dependencies:{...deps,fetch:async(url,init)=>{row.transportRequests++;if(url.endsWith('/api/chat'))row.inferenceAttempts++;return deps.fetch(url,init);},capture:e=>appendFileSync(wire,JSON.stringify({...e,bytes:undefined,base64:Buffer.from(e.bytes).toString('base64')})+'\n',{mode:0o600})}},modelText:item.hostile?[JSON.stringify(item.hostile)]:[]});
 const start=performance.now();try{
 if((await h.sign()).status!==200)throw Error('SIGN_SETUP');
 const before=(await h.request('/api/mandates/current')).value;
 const response=await h.request(item.task==='extraction'?'/api/mandates/compile':'/api/agent/propose',item.task==='extraction'?{text:item.text}:{request:item.text});
 row.status=response.status;row.serverDecision=response.value;row.signedStateUnchanged=JSON.stringify(before)===JSON.stringify((await h.request('/api/mandates/current')).value);
 }catch(e){row.error=e instanceof Error?e.message:'CASE_FAILED';}finally{row.durationMs=performance.now()-start;await h.close();}
 row.wireSha256=hash(existsSync(wire)?readFileSync(wire,'utf8'):'');report.attempts.push(row);writeFileSync(`${dir}/${runId}-${id}.json`,JSON.stringify(row,null,2)+'\n',{mode:0o600});save();
 console.log(`${id} HTTP ${row.status} ${Math.round(row.durationMs)}ms ${row.validated?.kind}`);
 }
 const gate=nativeReconcile(cases,repeat,report.attempts,context,p=>readFileSync(p,'utf8'));
 report.verdict=gate.pass?'PASS':'FAIL';report.summary=gate.perClass;report.gate=gate;report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({runId,verdict:report.verdict,summary:report.summary}));if(!gate.pass)process.exitCode=1;
}
