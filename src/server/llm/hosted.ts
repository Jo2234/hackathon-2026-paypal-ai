import { request } from 'node:https';
import { Readable } from 'node:stream';
import { requireVerifiedTls } from '../env.ts';
// Structural subset accepted by Zod schemas; no runtime dependency.
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
export const HOSTED_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const HOSTED_MODEL = 'openai/gpt-oss-20b';

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
  /** Raw body bytes/prefix; a body containing the credential is replaced with a redaction marker. Headers are never captured. */
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
export type HostedRequest<T> = Readonly<{
  /** Exact HOSTED_ENDPOINT only. */
  endpoint: string;
  model: string;
  tools: readonly ToolDefinition[];
  expectedTool: string;
  schema: Schema<T>;
  messages: readonly Message[];
  /** Absolute epoch milliseconds; includes fetch and streamed body reads. */
  deadlineMs: number;
  signal?: AbortSignal;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}>;
type Meta = { model: ModelIdentity; attempts: 0 | 1; retries: 0 };
export type HostedResult<T> = Meta & (
  | { kind: 'tool_call'; toolName: string; callId: string; arguments: T }
  | { kind: 'refusal'; reason: string }
  | { kind: 'invalid_output'; reason: string }
  | { kind: 'timeout'; reason: 'deadline' }
  | { kind: 'quota_error'; reason: 'quota_exceeded'; status: 429 }
  | { kind: 'auth_error'; reason: 'authentication_failed'; status: 401 | 403 }
  | { kind: 'transport_error'; reason: string; status?: number }
);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function endpointAllowed(input: string): boolean { return input === HOSTED_ENDPOINT; }

/** Inspect parsed JSON, including property names and strings containing more JSON.
 * Work is bounded; exhausted inspection is unsafe rather than partially trusted.
 * Base64 and case-folded echoes are rejected as defense in depth too. */
function secretInValue(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];
  const needle = secret.toLowerCase();
  let nodes = 0, characters = 0;
  while (pending.length) {
    if (++nodes > 100_000) return true;
    const item = pending.pop();
    if (typeof item === 'string') {
      characters += item.length;
      if (characters > 16_000_000) return true;
      if (item.toLowerCase().includes(needle)) return true;
      // Decode whole base64 strings, not arbitrary overlapping substrings.
      if (item.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(item)) {
        const decoded = Buffer.from(item, 'base64').toString('utf8');
        if (decoded !== item && decoded.toLowerCase().includes(needle)) return true;
      }
      try { const decoded: unknown = JSON.parse(item); if (decoded !== item) pending.push(decoded); }
      catch { /* Ordinary non-JSON strings have already been scanned. */ }
    } else if (Array.isArray(item)) pending.push(...item);
    else if (object(item)) for (const [key, child] of Object.entries(item)) pending.push(key, child);
  }
  return false;
}
function safeCapture(bytes: Uint8Array, complete: boolean, secret: string): boolean {
  // Partial/malformed bodies may contain an encoded suffix that cannot be parsed.
  if (!complete) return false;
  try { return !secretInValue(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)), secret); }
  catch { return false; }
}

/** One attempt only. Never executes a tool, repairs output, or substitutes fixtures. */
export async function callHosted<T>(input: HostedRequest<T>, deps: Dependencies = hostedDependencies()): Promise<HostedResult<T>> {
  // Credentials are never accepted as arguments or retained in configuration/capture.
  const secret = process.env['GROQ_API_KEY'];
  const scrub = (value: string): string => secret ? value.split(secret).join('[REDACTED]') : value;
  const meta: Meta = { model: { requested: scrub(input.model), returned: null }, attempts: 0, retries: 0 };
  const invalid = (reason: string): HostedResult<T> => ({ ...meta, kind: 'invalid_output', reason });
  const transport = (reason: string): HostedResult<T> => ({ ...meta, kind: 'transport_error', reason });
  try { requireVerifiedTls(process.env); } catch { return transport('tls_verification_required'); }
  if (!secret || !/^[A-Za-z0-9_-]{8,256}$/.test(secret)) return transport('hosted_key_required');
  if (input.model !== HOSTED_MODEL) return transport('model_rejected');
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
  if (!safeCapture(requestBytes, true, secret)) return transport('secret_in_request');
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
    try {
      // Headers are deliberately absent: Authorization can never enter this hook.
      deps.capture?.({ ...event, bytes: safeCapture(event.bytes, event.complete, secret!) ? event.bytes.slice() : new TextEncoder().encode('[REDACTED_SECRET_BODY]') });
    } catch { evidenceFailed = true; throw new Error('capture_failed'); }
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
    const work = async (): Promise<HostedResult<T>> => {
      capture({ phase: 'request', bytes: requestBytes.slice(), complete: true });
      if (input.signal?.aborted) stop(false);
      if (deps.now() >= input.deadlineMs) stop(true);
      if (controller.signal.aborted) throw new Error('stopped');
      meta.attempts = 1;
      const response = await deps.fetch(input.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: requestBytes as BodyInit, signal: controller.signal,
        redirect: 'error', credentials: 'omit',
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('stopped'); }
      status = response.status;
      // Classify before reading potentially malicious/unbounded error bodies.
      if (status === 429 || status === 401 || status === 403) {
        void response.body?.cancel().catch(() => {});
        captureResponse(false);
        return status === 429 ? { ...meta, kind: 'quota_error', reason: 'quota_exceeded', status: 429 }
          : { ...meta, kind: 'auth_error', reason: 'authentication_failed', status };
      }
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
      return parseHostedResponse(bytes,status,input.model,input.expectedTool,input.schema);
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


/** Direct TLS: no SDK, global dispatcher, proxy environment, redirect or retry.
 * Injected Dependencies are a trusted test seam, never exposed to HTTP callers. */
export async function directHostedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  requireVerifiedTls(process.env);
  if (!endpointAllowed(String(input)) || init.redirect !== 'error') throw new Error('HOSTED_ENDPOINT_REJECTED');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: 'api.groq.com', port: 443, path: '/openai/v1/chat/completions',
      method: 'POST', agent: false, rejectUnauthorized: true, signal: init.signal ?? undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    }, res => {
      try {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) { res.destroy(); reject(new Error('HOSTED_REDIRECT_REJECTED')); return; }
        if ([204, 205, 304].includes(status)) { res.destroy(); reject(new Error('HOSTED_BODY_REQUIRED')); return; }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status }));
      } catch { res.destroy(); reject(new Error('HOSTED_RESPONSE_FAILED')); }
    });
    req.on('error', () => reject(new Error('HOSTED_TRANSPORT_FAILED')));
    if (init.body) req.write(init.body);
    req.end();
  });
}
export function hostedDependencies(): Dependencies {
  return { fetch: directHostedFetch, now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>) };
}


/** Shared production/evidence parser. Pure response classification; no transport,
 * tool dispatch, retries, configuration mutation or fixture substitution. */
export function parseHostedResponse<T>(bytes:Uint8Array,status:number,model:string,expectedTool:string,schema:Schema<T>):HostedResult<T> {
  const meta:Meta={model:{requested:model,returned:null},attempts:1,retries:0};
  const invalid=(reason:string):HostedResult<T>=>({...meta,kind:'invalid_output',reason});
  const secret=process.env['GROQ_API_KEY'];
  if(status===429)return {...meta,kind:'quota_error',reason:'quota_exceeded',status};
  if(status===401||status===403)return {...meta,kind:'auth_error',reason:'authentication_failed',status};

  if (status < 200 || status >= 300) return { ...meta, kind: 'transport_error', reason: 'http_error', status };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return invalid('response_json_invalid'); }
  if (secret && secretInValue(body, secret)) return invalid('secret_in_response');
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
    return { ...meta, kind: 'refusal', reason: 'model_refused' };
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
