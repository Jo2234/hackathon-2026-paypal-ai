import { callOllamaNative, nativeDependencies } from './ollama-native.ts';
import { MODEL, API_DIGEST, PROMPT_VERSION as NARROW_VERSION } from './narrow.ts';
import { callHosted, hostedDependencies, HOSTED_ENDPOINT, HOSTED_MODEL } from './hosted.ts';
import type { Dependencies as HostedDependencies, HostedResult } from './hosted.ts';
import { readModes } from '../env.ts';
import { hostedProjection, restoreHosted } from './hosted-context.ts';
import { callLocal, directLocalFetch } from './local.ts';
import type { Dependencies, LocalResult } from './local.ts';
import { PROMPT_VERSION, POLICY_COMPILE_PROMPT, AGENT_PROPOSAL_PROMPT, buildModelContext, policyCompileTool, agentProposalTool } from './prompts.ts';
import { policySchema, proposalSchema } from '../../shared/schemas.ts';
export type LocalConfig = Readonly<{mode:'local';endpoint:string;model:string;digest:string|null;thinking:'off'|'on';promptSuffix:string;timeoutMs:number;tokens:number;dependencies?:Dependencies;native?:boolean;onContext?:(context:Readonly<Record<string,unknown>>)=>void;onResult?:(result:LocalResult<unknown>)=>void}>;
export function legacyLocalConfig(env:Readonly<Record<string,string|undefined>>):LocalConfig {
  const endpoint=env['LLM_LOCAL_URL']??'';
  if(!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/v1\/chat\/completions$/.test(endpoint))throw new Error('LOCAL_MODEL_LOOPBACK_REQUIRED');
  const model=env['LLM_LOCAL_MODEL']??'';
  if(!model || model.length>128 || /cloud/i.test(model))throw new Error('LOCAL_MODEL_REQUIRED');
  const timeoutMs=Number(env['LLM_LOCAL_TIMEOUT_MS']??55000),tokens=Number(env['LLM_LOCAL_TOKENS']??2048);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>55000||!Number.isInteger(tokens)||tokens<1||tokens>8192)throw new Error('LOCAL_MODEL_BOUNDS');
  const thinking=env['LLM_LOCAL_THINKING']??'off';if(thinking!=='off'&&thinking!=='on')throw new Error('LOCAL_MODEL_THINKING');
  const digest=env['LLM_LOCAL_DIGEST']??null;if(digest!==null&&!/^(sha256:)?[a-f0-9]{64}$/.test(digest))throw new Error('LOCAL_MODEL_DIGEST');
  return {mode:'local',endpoint,model,digest,thinking,promptSuffix:env['LLM_LOCAL_PROMPT_SUFFIX']??'',timeoutMs,tokens};
}
/** Pinned native recipe. Legacy full-tool transport remains an explicit test seam only. */
export function localConfig(env:Readonly<Record<string,string|undefined>>):LocalConfig {
 const endpoint=env['LLM_LOCAL_URL']??'http://127.0.0.1:11434/api/chat';
 if(!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/api\/chat$/.test(endpoint))throw new Error('LOCAL_MODEL_LOOPBACK_REQUIRED');
 for(const [key,value] of Object.entries({LLM_LOCAL_MODEL:MODEL,LLM_LOCAL_DIGEST:API_DIGEST,LLM_LOCAL_THINKING:'off',LLM_LOCAL_PROMPT_SUFFIX:'',LLM_LOCAL_TOKENS:'2048'}))if(env[key]!==undefined&&env[key]!==value)throw new Error('LOCAL_MODEL_PIN_REQUIRED');
 const timeoutMs=Number(env['LLM_LOCAL_TIMEOUT_MS']??55000);
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>55000)throw new Error('LOCAL_MODEL_BOUNDS');
 return {mode:'local',native:true,endpoint,model:MODEL,digest:API_DIGEST,thinking:'off',promptSuffix:'',timeoutMs,tokens:2048};
}
let nativeBusy=false;
export type HostedConfig = Readonly<{mode:'hosted';endpoint:string;model:string;digest:null;timeoutMs:number;tokens:number;dependencies?:HostedDependencies;onResult?:(result:HostedResult<unknown>)=>void;onContext?:(context:Readonly<Record<string,unknown>>)=>void}>;
export type ModelConfig = LocalConfig | HostedConfig;
export type ModelResult = LocalResult<unknown> | HostedResult<unknown>;
export function hostedConfig(env:Readonly<Record<string,string|undefined>>):HostedConfig {
  if(readModes({...env,LLM_MODE:'hosted'}).llm!=='hosted')throw new Error('HOSTED_MODEL_CONFIGURATION_REQUIRED');
  return {mode:'hosted',endpoint:HOSTED_ENDPOINT,model:HOSTED_MODEL,digest:null,timeoutMs:55000,tokens:2048};
}
export const compilerFor=(config:ModelConfig,model=config.model)=>({mode:config.mode,model,promptVersion:config.mode==='local'&&config.native?NARROW_VERSION:PROMPT_VERSION});
export async function infer(config:ModelConfig,kind:'compile'|'agent',ownerRequest:string,serverContext:Readonly<Record<string,unknown>>,signal:AbortSignal,remainingMs:number,merchantText:readonly string[]=[]) {
  if(config.mode==='hosted') {
    const dependencies=config.dependencies??hostedDependencies(),tool=kind==='compile'?policyCompileTool:agentProposalTool;
    const projected=hostedProjection(kind,ownerRequest,serverContext);
    config.onContext?.(serverContext);
    const result=await callHosted<unknown>({endpoint:config.endpoint,model:config.model,tools:[tool],expectedTool:tool.function.name,schema:kind==='compile'?policySchema:proposalSchema,
      messages:[{role:'system',content:kind==='compile'?POLICY_COMPILE_PROMPT:AGENT_PROPOSAL_PROMPT},{role:'user',content:buildModelContext({ownerRequest,serverContext:projected,merchantText})}],
      signal,deadlineMs:dependencies.now()+Math.min(config.timeoutMs,remainingMs),maxRequestBytes:65536,maxResponseBytes:262144,maxOutputTokens:config.tokens},dependencies);
    config.onResult?.(result);
    if(result.kind==='tool_call')return {...result,arguments:restoreHosted(kind,result.arguments,serverContext,projected)};
    return result;
  }
  if(config.native){
    config.onContext?.(serverContext);
    if(nativeBusy){const result={kind:'transport_error' as const,reason:'native_busy',model:{requested:MODEL,returned:null},attempts:0 as const,retries:0 as const};config.onResult?.(result);return result;}
    nativeBusy=true;
    try {
      const dependencies=config.dependencies??nativeDependencies();
      const result=await callOllamaNative({endpoint:config.endpoint,task:kind==='compile'?'extraction':'selection',ownerText:ownerRequest,signal,deadlineMs:dependencies.now()+Math.min(config.timeoutMs,remainingMs,150000),maxRequestBytes:65536,maxResponseBytes:262144},dependencies);
      config.onResult?.(result);return result;
    } finally {nativeBusy=false;}
  }
  const dependencies=config.dependencies??{fetch:directLocalFetch,now:Date.now,setTimer:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimer:(h:unknown)=>clearTimeout(h as ReturnType<typeof setTimeout>)};
  const tool=kind==='compile'?policyCompileTool:agentProposalTool;
  const result=await callLocal<unknown>({endpoint:config.endpoint,model:config.model,tools:[tool],expectedTool:tool.function.name,schema:kind==='compile'?policySchema:proposalSchema,
    messages:[{role:'system',content:(kind==='compile'?POLICY_COMPILE_PROMPT:AGENT_PROPOSAL_PROMPT)+config.promptSuffix},{role:'user',content:buildModelContext({ownerRequest,serverContext,merchantText})+(config.thinking==='off'?'\n/no_think':'\n/think')}],
    signal,deadlineMs:dependencies.now()+Math.min(config.timeoutMs,remainingMs),maxRequestBytes:65536,maxResponseBytes:262144,maxOutputTokens:config.tokens},dependencies);
  config.onResult?.(result);return result;
}
