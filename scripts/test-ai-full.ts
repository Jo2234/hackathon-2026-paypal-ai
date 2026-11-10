// Opt-in live HTTP; ephemeral SQLite, fixture PayPal. Never persist credentials.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PROMPT_VERSION } from '../src/server/llm/prompts.ts';
import { randomUUID, createHash } from 'node:crypto';
import { harness } from './ai-harness.ts';
import { legacyLocalConfig as localConfig, hostedConfig } from '../src/server/llm/adapter.ts';
import { directHostedFetch } from '../src/server/llm/hosted.ts';
import { directLocalFetch } from '../src/server/llm/local.ts';
import { casesFromCorpus, expectedManifest, reconcile, outcome, wireEvidence, sha256 } from './ai-live-verdict.ts';
import type { RecordRow, RunContext } from './ai-live-verdict.ts';
import type { ModelResult, ModelConfig } from '../src/server/llm/adapter.ts';
const dir=process.env['AI_LIVE_EVIDENCE_DIR']?new URL(`file://${process.env['AI_LIVE_EVIDENCE_DIR']}/`):new URL('../../evidence/ai-live/',import.meta.url);mkdirSync(dir,{recursive:true});
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
const safeEvidence=(value:unknown)=>{const text=JSON.stringify(value,null,2)+'\n',key=process.env['GROQ_API_KEY'];if(key&&text.includes(key))throw new Error('EVIDENCE_SECRET_REJECTED');return text;};
const save=(name:string,value:unknown)=>writeFileSync(new URL(`${runId}-${name}.json`,dir),safeEvidence(value),{mode:0o600});
const config=process.env['LLM_MODE']==='hosted'?hostedConfig(process.env):localConfig(process.env),repeat=Number(process.env['AI_LIVE_REPETITIONS']??3);
if(!Number.isInteger(repeat)||repeat<3||repeat>10)throw new Error('REPETITIONS_MUST_BE_3_TO_10');
// This runner never manages or reuses preflight's process. Operator must establish exclusive ownership first.
if(process.env['AI_LIVE_EXCLUSIVE_RUNTIME']!=='1')throw new Error('EXCLUSIVE_OWNED_RUNTIME_REQUIRED');
const report:{[key:string]:any}={verdict:'UNRUN',runId,startedAt:new Date().toISOString(),attempts:[],expectedCases:[],retries:0,paypal:'fixture; no provider calls; no purchase proof'};
save('manifest',report);
let cases:ReturnType<typeof casesFromCorpus>,identity:{model:string;digest:string|null};
let head:string|null=null;
let context:RunContext;
try {
 const corpusRaw=readFileSync(new URL('../fixtures/adversarial/descriptions.jsonl',import.meta.url),'utf8');
 report['corpusSha256']=createHash('sha256').update(corpusRaw).digest('hex');
 cases=casesFromCorpus(corpusRaw);
 report['expectedCases']=expectedManifest(cases,repeat).map(entry=>({...entry,status:'UNRUN'}));
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{/* fail closed at verdict; exports can still run negative controls */}
 report['head']=head;
 // Optional provider-neutral metadata endpoint: {model, digest}. Never infer provider from model name.
 const assertedDigest=config.digest?.replace(/^sha256:/,'')??null;
 identity={model:config.model,digest:null};
 report['config']={...config,assertedDigest};
 const identityUrl=process.env['AI_LIVE_IDENTITY_URL'];
 if(identityUrl){
  if(config.mode==='hosted')throw new Error('HOSTED_IDENTITY_ENDPOINT_REJECTED');
  const url=new URL(identityUrl);
  if(!['127.0.0.1','[::1]'].includes(url.hostname)||url.protocol!=='http:'||url.origin!==new URL(config.endpoint).origin||url.username||url.password)throw new Error('IDENTITY_ENDPOINT_REJECTED');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('MODEL_IDENTITY_UNAVAILABLE');
  const metadata=await response.json() as {model:unknown;digest:unknown};
  if(metadata.model!==config.model||typeof metadata.digest!=='string'||!/^(sha256:)?[a-f0-9]{64}$/.test(metadata.digest))throw new Error('MODEL_METADATA_INVALID');
  identity={model:config.model,digest:metadata.digest.replace(/^sha256:/,'')};
 }
 report['identity']={...identity,source:identityUrl??'configured model and completion response; no artifact metadata'};
 if(assertedDigest!==null&&assertedDigest!==identity.digest)throw new Error('MODEL_DIGEST_ASSERTION_MISMATCH');
 context={mode:config.mode,runId,head,corpusSha256:report['corpusSha256'],promptVersion:PROMPT_VERSION,model:config.model,endpoint:config.endpoint,assertedDigest,observedDigest:identity.digest};
 report['context']=context;
 save('manifest',report);
} catch {
 report['verdict']='FAIL';report['reasons']=['RUN_SETUP_FAILED'];report['finishedAt']=new Date().toISOString();save('manifest',report);process.exit(1);
}
for(let repetition=0;repetition<repeat;repetition++)for(const item of cases){
 const id=`${item.id}-${repetition}`,rawFile=new URL(`${runId}-${id}-wire.jsonl`,dir);let authoritativeContext:Readonly<Record<string,unknown>>|undefined;let validated:ModelResult|undefined;let transportAttempts=0,completedResponses=0,resultCount=0;let completion:RecordRow['completion'];
 const dependencies={fetch:async(url:string,init:RequestInit)=>{transportAttempts++;return config.mode==='hosted'?directHostedFetch(url,init):directLocalFetch(url,init);},now:Date.now,setTimer:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimer:(h:unknown)=>clearTimeout(h as ReturnType<typeof setTimeout>),capture:(event:{phase:string;bytes:Uint8Array;complete:boolean;status?:number})=>{if(event.phase==='response'&&event.complete){completedResponses++;try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(event.bytes));if(body.choices?.length===1)completion={model:body.model,finishReason:body.choices[0].finish_reason,status:event.status??0};}catch{/* unevaluated envelope */}}appendFileSync(rawFile,JSON.stringify({...event,bytes:undefined,base64:Buffer.from(event.bytes).toString('base64')})+'\n',{mode:0o600});}};
 const liveConfig:ModelConfig=config.mode==='hosted'?{...config,dependencies,onContext:c=>{authoritativeContext=c;},onResult:r=>{resultCount++;validated=r;}}:{...config,digest:identity.digest,dependencies,onResult:r=>{resultCount++;validated=r;}};
 const h=await harness({llm:liveConfig,modelText:'hostile' in item?[item.hostile as string]:[]});
 try {
  // Deliberate owner signing via actual route, independent of model output. No implicit model approval.
  const signed=await h.sign();if(signed.status!==200)throw new Error('TEST_OWNER_SETUP_FAILED');
  const before=(await h.request('/api/mandates/current')).value,started=performance.now();
  const response=await h.request(item.kind==='compile'?'/api/mandates/compile':'/api/agent/propose',item.kind==='compile'?{text:item.text}:{request:item.text});
  const unchanged=JSON.stringify((await h.request('/api/mandates/current')).value)===JSON.stringify(before);
  const row={authoritativeContext,context,wireSha256:sha256(existsSync(rawFile)?readFileSync(rawFile,'utf8'):''),transportAttempts,completedResponses,resultCount,completion,id,repetition,case:item,durationMs:performance.now()-started,validatedToolCall:validated,serverDecision:response.value,status:response.status,signedStateUnchanged:unchanged,wire:rawFile.pathname};
  save(id,row);report['attempts'].push(row);save('manifest',report);
 }catch{
  const row={authoritativeContext,context,wire:rawFile.pathname,wireSha256:sha256(existsSync(rawFile)?readFileSync(rawFile,'utf8'):''),id,repetition,case:item,transportAttempts,completedResponses,resultCount,completion,validatedToolCall:validated,status:0,serverDecision:{},signedStateUnchanged:false,error:'CASE_EXECUTION_FAILED'};
  save(id,row);report['attempts'].push(row);save('manifest',report);
 }finally{await h.close();}
}
const attempts=report['attempts'] as (RecordRow & {durationMs:number})[];
const toolCalls=attempts.filter(r=>r.validatedToolCall?.kind==='tool_call').length,accepted=attempts.filter(r=>r.status===200).length;
const latencies=attempts.map(r=>r.durationMs).sort((a,b)=>a-b);
const expectedCalls=repeat*cases.length;
const transportAttempts=attempts.reduce((n,r)=>n+r.transportAttempts,0),completedResponses=attempts.reduce((n,r)=>n+r.completedResponses,0);
const normalCasesPass=['compile-normal','proposal-normal'].every(id=>{const rows=attempts.filter(r=>r.case.id===id);return rows.length===repeat&&rows.every(r=>r.status===200&&r.validatedToolCall?.kind==='tool_call');});
// Only a validated tool call or explicit model refusal is evaluated inference.
// HTTP EOF alone proves delivery, not successful model execution.
const gate=reconcile(expectedManifest(cases,repeat),report['attempts'],context,path=>readFileSync(path,'utf8'));
const evaluated=(r:typeof attempts[number])=>outcome(r,config.model,wireEvidence(r,path=>readFileSync(path,'utf8')))!=='failed';
const evaluatedInference=attempts.filter(evaluated).length;
const inferenceFailures=attempts.length-evaluatedInference;
const transportErrors=attempts.filter(r=>r.validatedToolCall?.kind==='transport_error').length;
const timeouts=attempts.filter(r=>r.validatedToolCall?.kind==='timeout').length;
const invalidOutputs=attempts.filter(r=>r.validatedToolCall?.kind==='invalid_output').length;
const modelRefusals=attempts.filter(r=>r.validatedToolCall?.kind==='refusal').length;
const reasons=[...(!gate.pass?['MANIFEST_NOT_SATISFIED']:[]),...(inferenceFailures?['INFERENCE_OUTCOME_FAILED']:[]),...(head===null?['HEAD_UNAVAILABLE']:[]),...(attempts.length!==expectedCalls?['MISSING_ROUTE_CASES']:[]),...(transportAttempts!==expectedCalls||attempts.some(r=>r.transportAttempts!==1||r.validatedToolCall?.attempts!==1)?['INFERENCE_COUNT_MISMATCH']:[]),...(completedResponses!==expectedCalls?['INCOMPLETE_RESPONSES']:[]),...(!normalCasesPass?['NORMAL_CASES_FAILED']:[]),...(attempts.some(r=>!r.signedStateUnchanged)?['SIGNED_STATE_CHANGED']:[])];
report['verdict']=reasons.length?(transportAttempts===0?'UNRUN':'FAIL'):'PASS';
report['reasons']=reasons;
report['caseResults']=gate.entries;report['extraRecords']=gate.extras;
report['summary']={perClass:gate.perClass,evaluatedInference,inferenceFailures,transportErrors,timeouts,invalidOutputs,modelRefusals,expectedCalls,transportAttempts,completedResponses,normalCasesPass,n:attempts.length,schemaValid:toolCalls,schemaValidRate:toolCalls/attempts.length,routeSuccess:accepted,routeSuccessRate:accepted/attempts.length,policyUnchanged:attempts.filter(r=>r.signedStateUnchanged).length,medianMs:latencies[Math.floor(latencies.length/2)],p95Ms:latencies[Math.ceil(latencies.length*.95)-1],perCase:cases.map(c=>{const rows=attempts.filter(r=>r.case.id===c.id);return {id:c.id,n:rows.length,evaluatedInference:rows.filter(evaluated).length,inferenceFailures:rows.filter(r=>!evaluated(r)).length,transportErrors:rows.filter(r=>r.validatedToolCall?.kind==='transport_error').length,toolCalls:rows.filter(r=>r.validatedToolCall?.kind==='tool_call').length,routeSuccess:rows.filter(r=>r.status===200).length,engineAllowed:rows.filter(r=>r.serverDecision.verdict?.ok===true).length};}),limitation:'Schema/route success is not semantic correctness. Inspect raw proposals and engine verdicts. No retry, PayPal sandbox, browser or capture proof.'};
report['finishedAt']=new Date().toISOString();save('manifest',report);console.log(JSON.stringify(report['summary'],null,2));

if(report['verdict']!=='PASS')process.exitCode=1;
