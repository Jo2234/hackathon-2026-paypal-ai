import { request } from 'node:http';
import { Readable } from 'node:stream';
import type { z } from 'zod';

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
}>;
export type Dependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Synchronous, fast, nonthrowing evidence sink. Failure fails the call closed. */
  capture?: (event: Capture) => void;
}>;
export type LocalRequest<T> = Readonly<{
  /** Full endpoint, e.g. http://127.0.0.1:11434/v1/chat/completions. */
  endpoint: string;
  model: string;
  tools: readonly ToolDefinition[];
  expectedTool: string;
  schema: z.ZodType<T>;
  messages: readonly Message[];
  /** Absolute epoch milliseconds; includes fetch and streamed body reads. */
  deadlineMs: number;
  signal?: AbortSignal;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
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
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/v1\/chat\/completions$/.test(input)) return false;
  try {
    const url = new URL(input);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** One attempt only. Never executes a tool, repairs output, or substitutes fixtures. */
export async function callLocal<T>(input: LocalRequest<T>, deps: Dependencies): Promise<LocalResult<T>> {
  const meta: Meta = { model: { requested: input.model, returned: null }, attempts: 0, retries: 0 };
  const invalid = (reason: string): LocalResult<T> => ({ ...meta, kind: 'invalid_output', reason });
  const transport = (reason: string): LocalResult<T> => ({ ...meta, kind: 'transport_error', reason });
  if (!endpointAllowed(input.endpoint)) return transport('endpoint_rejected');
  const remaining = input.deadlineMs - deps.now();
  if (!Number.isFinite(remaining) || remaining > 2_147_483_647) return transport('invalid_deadline');
  if (remaining <= 0) return { ...meta, kind: 'timeout', reason: 'deadline' };
  if (input.signal?.aborted) return transport('aborted');
  if (![input.maxRequestBytes, input.maxResponseBytes, input.maxOutputTokens].every(n => Number.isSafeInteger(n) && n > 0)
    || !input.model.trim() || !input.expectedTool
    || input.tools.filter(t => t.function.name === input.expectedTool).length !== 1
    || new Set(input.tools.map(t => t.function.name)).size !== input.tools.length) return transport('invalid_configuration');
  let requestBytes: Uint8Array;
  try {
    requestBytes = new TextEncoder().encode(JSON.stringify({
      model: input.model, messages: input.messages, tools: input.tools,
      tool_choice: { type: 'function', function: { name: input.expectedTool } },
      parallel_tool_calls: false, stream: false, temperature: 0, max_tokens: input.maxOutputTokens,
    }));
  } catch { return transport('request_serialization_failed'); }
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
    capture({ phase: 'response', bytes, complete, status });
  };
  try {
    const work = async (): Promise<LocalResult<T>> => {
      capture({ phase: 'request', bytes: requestBytes.slice(), complete: true });
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
      return parseLocalResponse(bytes,status,input.model,input.expectedTool,input.schema);
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
    try { captureResponse(false); } catch { /* original failure already classified */ }
  }
}

/** Literal loopback HTTP only. node:http with agent:false never consults proxy
 * environment variables, global fetch dispatchers, or --use-env-proxy. */
export async function directLocalFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const literal=String(input);
  if(!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/(v1\/chat\/completions|api\/tags)$/.test(literal))throw new Error('LOCAL_ENDPOINT_REJECTED');
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


/** Shared production/evidence parser. Pure response classification; no transport,
 * tool dispatch, retries, configuration mutation or fixture substitution. */
export function parseLocalResponse<T>(bytes:Uint8Array,status:number,model:string,expectedTool:string,schema:z.ZodType<T>):LocalResult<T> {
  const meta:Meta={model:{requested:model,returned:null},attempts:1,retries:0};
  const invalid=(reason:string):LocalResult<T>=>({...meta,kind:'invalid_output',reason});

  if (status < 200 || status >= 300) return { ...meta, kind: 'transport_error', reason: 'http_error', status };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return invalid('response_json_invalid'); }
  if (!object(body)) return invalid('response_envelope_invalid');
  if (typeof body.model !== 'string' || !body.model) return invalid('model_missing');
  meta.model = { requested: model, returned: body.model };
  if (body.model !== model) return invalid('model_mismatch');
  if (!Array.isArray(body.choices) || body.choices.length !== 1) return invalid('choice_count');
  const choice: unknown = body.choices[0];
  if (!object(choice) || !object(choice.message) || choice.message.role !== 'assistant') return invalid('message_invalid');
  const message = choice.message;
  const calls = message.tool_calls;
  if (calls !== undefined && !Array.isArray(calls)) return invalid('tool_calls_invalid');
  if (Array.isArray(calls) && calls.length > 1) return invalid('tool_call_count');
  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    if (Array.isArray(calls) && calls.length) return invalid('refusal_with_tool_call');
    return { ...meta, kind: 'refusal', reason: message.refusal };
  }
  if (choice.finish_reason !== 'tool_calls') return invalid('finish_reason');
  if (!Array.isArray(calls) || calls.length !== 1) return invalid('tool_call_count');
  const call: unknown = calls[0];
  if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || !object(call.function)) return invalid('tool_call_invalid');
  if (call.function.name !== expectedTool) return invalid('wrong_tool');
  if (typeof call.function.arguments !== 'string') return invalid('arguments_not_string');
  let args: unknown;
  try { args = JSON.parse(call.function.arguments); } catch { return invalid('arguments_json_invalid'); }
  // No eval, repair, object merge, or prototype-sensitive assignment of model output.
  try {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return invalid('arguments_schema_invalid');
    return { ...meta, kind: 'tool_call', toolName: expectedTool, callId: call.id, arguments: parsed.data };
  } catch { return invalid('arguments_schema_failed'); }
}
