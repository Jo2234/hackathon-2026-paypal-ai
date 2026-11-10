import { request } from 'node:http';
import { Readable } from 'node:stream';
import { buildNarrowRequest, outputContract, MODEL, API_DIGEST, type Task } from './narrow.ts';

export type ToolDefinition = Readonly<{
  type: 'function';
  function: Readonly<{ name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean }>;
}>;
export type Message = Readonly<{
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: readonly Readonly<{ id: string; type: 'function'; function: { name: string; arguments: string } }>[];
}>;
export type ModelIdentity = Readonly<{ requested: string; returned: string | null }>;
export type Capture = Readonly<{
  phase: 'request' | 'response';
  /** Raw body bytes; prepared request or bounded response prefix when incomplete. */
  bytes: Uint8Array;
  complete: boolean;
  status?: number;
  endpoint?: string;
}>;
export type Dependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Synchronous, fast, nonthrowing evidence sink. Failure fails the call closed. */
  capture?: (event: Capture) => void;
}>;
export type NativeRequest = Readonly<{
  endpoint: string;
  task: Task;
  ownerText: string;
  deadlineMs: number;
  signal?: AbortSignal;
  maxRequestBytes: number;
  maxResponseBytes: number;
}>;
type Meta = { model: ModelIdentity; attempts: 0 | 1; retries: 0 };
export type LocalResult<T> = Meta & (
  | { kind: 'tool_call'; toolName: string; callId: string; arguments: T }
  | { kind: 'refusal'; reason: string }
  | { kind: 'invalid_output'; reason: string }
  | { kind: 'timeout'; reason: 'deadline' }
  | { kind: 'transport_error'; reason: string; status?: number }
);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function endpointAllowed(input: string): boolean {
  // Check literal authority before URL canonicalization (reject numeric/encoded aliases).
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/api\/chat$/.test(input)) return false;
  try {
    const url = new URL(input);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** One attempt only. Never executes a tool, repairs output, or substitutes fixtures. */
export async function callOllamaNative(input: NativeRequest, deps: Dependencies = nativeDependencies()): Promise<LocalResult<unknown>> {
  const meta: Meta = { model: { requested: MODEL, returned: null }, attempts: 0, retries: 0 };
  const invalid = (reason: string): LocalResult<unknown> => ({ ...meta, kind: 'invalid_output', reason });
  const transport = (reason: string): LocalResult<unknown> => ({ ...meta, kind: 'transport_error', reason });
  if (!endpointAllowed(input.endpoint)) return transport('endpoint_rejected');
  const remaining = input.deadlineMs - deps.now();
  if (!Number.isFinite(remaining) || remaining > 150_000) return transport('invalid_deadline');
  if (remaining <= 0) return { ...meta, kind: 'timeout', reason: 'deadline' };
  if (input.signal?.aborted) return transport('aborted');
  if (![input.maxRequestBytes, input.maxResponseBytes].every(n => Number.isSafeInteger(n) && n > 0)
    || !['extraction','selection'].includes(input.task)) return transport('invalid_configuration');
  let requestBytes: Uint8Array;
  try { requestBytes = new TextEncoder().encode(JSON.stringify(buildNarrowRequest(input.task, input.ownerText))); }
  catch { return transport('request_serialization_failed'); }
  if (requestBytes.byteLength > input.maxRequestBytes) return invalid('request_too_large');

  const controller = new AbortController();
  let timedOut = false;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (deadline: boolean) => {
    if (controller.signal.aborted) return;
    timedOut = deadline;
    controller.abort();
    rejectStop(new Error('stopped'));
  };
  const onAbort = () => stop(false);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = deps.setTimer(() => stop(true), Math.max(0, input.deadlineMs - deps.now()));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let identityReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let identityPartial: {endpoint:string;status:number;parts:Uint8Array[];captured:boolean} | undefined;
  let status: number | undefined;
  let total = 0;
  const chunks: Uint8Array[] = [];
  let responseCaptured = false;
  let evidenceFailed = false;
  const capture = (event: Capture) => {
    try { deps.capture?.(event); } catch { evidenceFailed = true; throw new Error('capture_failed'); }
  };
  const captureResponse = (complete: boolean) => {
    if (responseCaptured || status === undefined) return;
    responseCaptured = true;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    capture({ phase: 'response', bytes, complete, status, endpoint:input.endpoint });
  };
  try {
    const work = async (): Promise<LocalResult<unknown>> => {
      // Runtime metadata is queried on every call, never trusted from configuration.
      for (const [path, check] of [
        ['/api/version', (b: any) => b.version === '0.40.15'],
        ['/api/tags', (b: any) => Array.isArray(b.models) && b.models.filter((m: any) => m.name === MODEL).length === 1 && b.models.find((m: any) => m.name === MODEL)?.digest?.replace(/^sha256:/,'') === API_DIGEST],
      ] as const) {
        if (controller.signal.aborted) throw new Error('stopped');
        const endpoint = new URL(path, input.endpoint).href;
        capture({phase:'request',bytes:new Uint8Array(),complete:true,endpoint});
        const response = await deps.fetch(endpoint,{method:'GET',signal:controller.signal,redirect:'error',credentials:'omit'});
        if (controller.signal.aborted) { void response.body?.cancel().catch(()=>{}); throw new Error('stopped'); }
        identityReader = response.body?.getReader();
        if (!identityReader) return transport('identity_missing_body');
        const parts: Uint8Array[] = []; let size=0;
        identityPartial={endpoint,status:response.status,parts,captured:false};
        try {
          for (;;) {
            const part = await identityReader.read();
            if (controller.signal.aborted) throw new Error('stopped');
            if (part.done) break;
            const prefix=part.value.slice(0,input.maxResponseBytes-size); parts.push(prefix); size+=prefix.length;
            if (prefix.length!==part.value.length) {
              identityPartial.captured=true;
              capture({phase:'response',bytes:Buffer.concat(parts),complete:false,status:response.status,endpoint});
              return invalid('identity_response_too_large');
            }
          }
        } finally { void identityReader.cancel().catch(()=>{}); }
        const bytes=Buffer.concat(parts);
        identityPartial.captured=true;
        capture({phase:'response',bytes,complete:true,status:response.status,endpoint});
        if (!response.ok) return transport('identity_http_error');
        try { if(!check(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))) return invalid('runtime_identity_mismatch'); }
        catch { return invalid('identity_json_invalid'); }
      }
      capture({ phase: 'request', bytes: requestBytes.slice(), complete: true, endpoint:input.endpoint });
      if (input.signal?.aborted) stop(false);
      if (deps.now() >= input.deadlineMs) stop(true);
      if (controller.signal.aborted) throw new Error('stopped');
      meta.attempts = 1;
      const response = await deps.fetch(input.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: requestBytes as BodyInit, signal: controller.signal,
        redirect: 'error', credentials: 'omit',
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('stopped'); }
      status = response.status;
      reader = response.body?.getReader();
      if (!reader) { captureResponse(true); return invalid('missing_body'); }
      for (;;) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new Error('stopped');
        if (part.done) break;
        const space = input.maxResponseBytes - total;
        const chunk = part.value.slice(0, space);
        chunks.push(chunk); total += chunk.length;
        if (part.value.length > space) {
          captureResponse(false);
          return invalid('response_too_large');
        }
      }
      captureResponse(true);
      const bytes = new Uint8Array(total);
      let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return parseOllamaNativeResponse(bytes,status,input.task);
    };
    const result = await Promise.race([work(), stopped]);
    if (deps.now() >= input.deadlineMs) return { ...meta, kind: 'timeout', reason: 'deadline' };
    return result;
  } catch {
    if (evidenceFailed) return transport('capture_failed');
    if (timedOut) return { ...meta, kind: 'timeout', reason: 'deadline' };
    return transport(controller.signal.aborted ? 'aborted' : 'fetch_or_body_failed');
  } finally {
    deps.clearTimer(timer);
    input.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    // Cancellation must not delay a timeout even when an injected transport stalls.
    void reader?.cancel().catch(() => {});
    void identityReader?.cancel().catch(() => {});
    if(identityPartial&&!identityPartial.captured) {
      identityPartial.captured=true;
      try {capture({phase:'response',bytes:Buffer.concat(identityPartial.parts),complete:false,status:identityPartial.status,endpoint:identityPartial.endpoint});} catch {/* preserve original failure */}
    }
    try { captureResponse(false); } catch { /* original failure already classified */ }
  }
}

/** Literal loopback HTTP only. node:http with agent:false never consults proxy
 * environment variables, global fetch dispatchers, or --use-env-proxy. */
export async function directLocalFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const literal=String(input);
  if(!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/(api\/chat|api\/tags|api\/version)$/.test(literal))throw new Error('LOCAL_ENDPOINT_REJECTED');
  const url=new URL(literal);
  return new Promise<Response>((resolve,reject)=>{
    const req=request({hostname:url.hostname==='[::1]'?'::1':url.hostname,port:url.port||80,path:url.pathname,
      method:init.method??'GET',agent:false,signal:init.signal??undefined,
      headers:init.body?{'content-type':'application/json'}:{}},res=>{
      // Exceptions in this asynchronous callback must reject the transport,
      // never escape as an uncaught exception in the application process.
      try {
        const status=res.statusCode??502;
        if([204,205,304].includes(status)) {
          res.resume();reject(new Error('LOCAL_RESPONSE_BODY_REQUIRED'));return;
        }
        // Redirects are returned, never followed; callLocal rejects non-2xx.
        const headers=new Headers();
        for(const [key,value] of Object.entries(res.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
        const body=Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(new Response(body,{status,headers}));
      } catch(error) {res.destroy();reject(error);}
    });
    req.on('error',reject);
    if(init.body)req.write(init.body);
    req.end();
  });
}


/** Pure production/parser-replay seam. A normalized tool_call is a typed result,
 * not a native Ollama tool invocation. Prose refusals fail JSON validation. */
export function parseOllamaNativeResponse(bytes: Uint8Array, status: number, task: Task): LocalResult<unknown> {
  const meta: Meta = {model:{requested:MODEL,returned:null},attempts:1,retries:0};
  const invalid=(reason:string):LocalResult<unknown>=>({...meta,kind:'invalid_output',reason});
  if(status<200||status>=300)return {...meta,kind:'transport_error',reason:'http_error',status};
  let body:unknown;
  try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return invalid('response_json_invalid');}
  if(!object(body))return invalid('response_envelope_invalid');
  if(typeof body.model!=='string')return invalid('model_missing');
  meta.model={requested:MODEL,returned:body.model};
  if(body.model!==MODEL)return invalid('model_mismatch');
  if(body.done!==true||body.done_reason!=='stop')return invalid('finish_reason');
  if(!object(body.message)||body.message.role!=='assistant'||typeof body.message.content!=='string')return invalid('message_invalid');
  const m=body.message;
  if((m.thinking!==undefined&&m.thinking!=='')||m.tool_calls!==undefined)return invalid('unexpected_thinking_or_tools');
  let args:unknown;
  try {args=JSON.parse(m.content as string);}catch{return invalid('arguments_json_invalid');}
  try {
    const contract=outputContract(task), parsed=contract.schema.safeParse(args);
    if(!parsed.success)return invalid('arguments_schema_invalid');
    return {...meta,kind:'tool_call',toolName:contract.name,callId:'ollama-native',arguments:parsed.data};
  }catch{return invalid('arguments_schema_failed');}
}
export function nativeDependencies(): Dependencies {
  return {fetch:directLocalFetch,now:Date.now,setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:h=>clearTimeout(h as ReturnType<typeof setTimeout>)};
}
