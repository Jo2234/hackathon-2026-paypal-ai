import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { callLocal, type Capture, type Dependencies, type LocalRequest } from '../../src/server/llm/local.ts';

const schema = z.object({ sku: z.string(), qty: z.number().int().positive() }).strict();
const request = (): LocalRequest<z.infer<typeof schema>> => ({
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen3:4b',
  tools: [{ type: 'function', function: { name: 'propose_cart', parameters: { type: 'object' } } }],
  expectedTool: 'propose_cart', schema, messages: [{ role: 'user', content: 'one notebook' }],
  deadlineMs: Date.now() + 10_000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 384,
});
const call = (name = 'propose_cart', args = '{"sku":"book","qty":1}') => ({
  id: 'call_1', type: 'function', function: { name, arguments: args },
});
const envelope = (calls: unknown[] = [call()]) => ({
  model: 'qwen3:4b', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }],
});
const deps = (fetcher: Dependencies['fetch']): Dependencies => ({
  fetch: fetcher, now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
const jsonDeps = (value: unknown) => deps(async () => new Response(JSON.stringify(value)));

 test('valid call is typed, single-attempt, credential-free and captures exact bytes', async () => {
  const events: Capture[] = [];
  let count = 0;
  const value = envelope();
  const d = deps(async (url, init) => {
    count++;
    assert.equal(url, request().endpoint);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    const wire = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
    assert.equal(wire.parallel_tool_calls, false); assert.equal(wire.stream, false);
    assert.equal(wire.tool_choice.function.name, 'propose_cart');
    return new Response(JSON.stringify(value));
  });
  const result = await callLocal(request(), { ...d, capture: e => events.push(e) });
  assert.equal(result.kind, 'tool_call');
  if (result.kind === 'tool_call') assert.deepEqual(result.arguments, { sku: 'book', qty: 1 });
  assert.deepEqual(result.model, { requested: 'qwen3:4b', returned: 'qwen3:4b' });
  assert.equal(result.attempts, 1); assert.equal(result.retries, 0); assert.equal(count, 1);
  assert.deepEqual(events.map(e => [e.phase, e.complete]), [['request', true], ['response', true]]);
  assert.equal(new TextDecoder().decode(events[1]!.bytes), JSON.stringify(value));
});

test('malformed envelope JSON', async () => {
  const r = await callLocal(request(), deps(async () => new Response('{')));
  assert.equal(r.kind, 'invalid_output'); assert.equal('reason' in r && r.reason, 'response_json_invalid');
});
test('malformed argument JSON', async () => {
  const r = await callLocal(request(), jsonDeps(envelope([call('propose_cart', '{')])));
  assert.equal('reason' in r && r.reason, 'arguments_json_invalid');
});
test('wrong tool', async () => {
  const r = await callLocal(request(), jsonDeps(envelope([call('capture_payment')])));
  assert.equal('reason' in r && r.reason, 'wrong_tool');
});
test('two calls including unauthorized second call', async () => {
  const r = await callLocal(request(), jsonDeps(envelope([call(), call('capture_payment')])));
  assert.equal('reason' in r && r.reason, 'tool_call_count');
});
test('schema rejects invalid quantities, extra fields and prototype payload', async () => {
  for (const args of ['{"sku":"book","qty":0}', '{"sku":"book","qty":1,"extra":true}', '{"sku":"book","qty":1,"__proto__":{"polluted":true}}']) {
    const r = await callLocal(request(), jsonDeps(envelope([call('propose_cart', args)])));
    assert.equal('reason' in r && r.reason, 'arguments_schema_invalid');
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test('oversized streaming body stops at cap and cancels', async () => {
  let cancelled = false;
  const captures: Capture[] = [];
  const response = new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(50)); c.enqueue(new Uint8Array(50)); },
    cancel() { cancelled = true; },
  }));
  const r = await callLocal({ ...request(), maxResponseBytes: 64 }, {
    ...deps(async () => response), capture: e => captures.push(e),
  });
  assert.equal('reason' in r && r.reason, 'response_too_large');
  assert.equal(captures[1]!.bytes.length, 64); assert.equal(captures[1]!.complete, false);
  assert.equal(cancelled, true);
});
test('response exactly at byte cap succeeds, UTF-8 bytes are counted', async () => {
  const wire = JSON.stringify(envelope([call('propose_cart', '{"sku":"筆","qty":1}')]));
  const cap = new TextEncoder().encode(wire).length;
  const r = await callLocal({ ...request(), maxResponseBytes: cap }, deps(async () => new Response(wire)));
  assert.equal(r.kind, 'tool_call');
  const tooSmall = await callLocal({ ...request(), maxResponseBytes: cap - 1 }, deps(async () => new Response(wire)));
  assert.equal('reason' in tooSmall && tooSmall.reason, 'response_too_large');
});
test('oversized request never contacts transport', async () => {
  const r = await callLocal({ ...request(), maxRequestBytes: 1 }, deps(async () => { throw Error('must not fetch'); }));
  assert.equal('reason' in r && r.reason, 'request_too_large'); assert.equal(r.attempts, 0);
});
test('deadline bounds fetch even if injected fetch ignores AbortSignal', async () => {
  const r = await callLocal({ ...request(), deadlineMs: Date.now() + 20 }, deps(() => new Promise(() => {})));
  assert.equal(r.kind, 'timeout'); assert.equal(r.attempts, 1);
});
test('deadline bounds stalled response body and captures partial bytes', async () => {
  const events: Capture[] = [];
  const r = await callLocal({ ...request(), deadlineMs: Date.now() + 20 }, {
    ...deps(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }))),
    capture: e => events.push(e),
  });
  assert.equal(r.kind, 'timeout'); assert.equal(events[1]!.complete, false); assert.equal(events[1]!.bytes.length, 1);
});
test('caller cancellation is reported separately from deadline', async () => {
  const abort = new AbortController();
  const pending = callLocal({ ...request(), signal: abort.signal }, deps(() => new Promise(() => {})));
  abort.abort();
  const r = await pending;
  assert.equal(r.kind, 'transport_error'); assert.equal('reason' in r && r.reason, 'aborted');
});
test('expired and pre-aborted requests make zero attempts', async () => {
  const d = deps(async () => { throw Error('must not fetch'); });
  const expired = await callLocal({ ...request(), deadlineMs: Date.now() - 1 }, d);
  assert.equal(expired.kind, 'timeout'); assert.equal(expired.attempts, 0);
  const r = await callLocal({ ...request(), signal: AbortSignal.abort() }, d);
  assert.equal('reason' in r && r.reason, 'aborted'); assert.equal(r.attempts, 0);
});
test('rejects all nonliteral loopback/credential/redirect surfaces before fetch', async () => {
  for (const endpoint of [
    'https://127.0.0.1/v1/chat/completions', 'http://localhost:11434/v1/chat/completions',
    'http://example.com/v1/chat/completions', 'http://127.0.0.2/v1/chat/completions',
    'http://2130706433/v1/chat/completions', 'http://127.1/v1/chat/completions',
    'http://user:pass@127.0.0.1/v1/chat/completions', 'http://[::ffff:127.0.0.1]/v1/chat/completions',
    'http://127.0.0.1/v1/chat/completions?key=secret', 'http://127.0.0.1/v1/chat/completions#hash',
  ]) {
    let count = 0;
    const r = await callLocal({ ...request(), endpoint }, deps(async () => { count++; return new Response(''); }));
    assert.equal('reason' in r && r.reason, 'endpoint_rejected', endpoint); assert.equal(count, 0);
  }
});
test('IPv6 literal loopback is accepted', async () => {
  assert.equal((await callLocal({ ...request(), endpoint: 'http://[::1]:11434/v1/chat/completions' }, jsonDeps(envelope()))).kind, 'tool_call');
});
test('explicit refusal, plain text, truncated call, and model mismatch', async () => {
  const refusal = { model: 'qwen3:4b', choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'Cannot comply' } }] };
  assert.equal((await callLocal(request(), jsonDeps(refusal))).kind, 'refusal');
  const truncated = envelope(); truncated.choices[0]!.finish_reason = 'length';
  assert.equal((await callLocal(request(), jsonDeps(truncated))).kind, 'invalid_output');
  assert.equal((await callLocal(request(), jsonDeps({ ...envelope(), model: 'other' }))).kind, 'invalid_output');
  assert.equal((await callLocal(request(), jsonDeps({ model: 'qwen3:4b', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }] }))).kind, 'invalid_output');
});
test('HTTP and fetch failures are reported without retry', async () => {
  for (const fetcher of [async () => new Response('unavailable', { status: 503 }), async () => { throw new Error('offline'); }]) {
    let attempts = 0;
    const r = await callLocal(request(), deps(async () => { attempts++; return fetcher(); }));
    assert.equal(r.kind, 'transport_error'); assert.equal(attempts, 1); assert.equal(r.retries, 0);
  }
});
test('evidence sink failure fails closed before fetch', async () => {
  let count = 0;
  const r = await callLocal(request(), { ...deps(async () => { count++; return new Response(''); }), capture: () => { throw Error('disk full'); } });
  assert.equal('reason' in r && r.reason, 'capture_failed'); assert.equal(count, 0);
});
test('invalid UTF-8, missing identity, multiple choices and non-string arguments fail closed', async () => {
  const badUtf = await callLocal(request(), deps(async () => new Response(new Uint8Array([0xff]))));
  assert.equal('reason' in badUtf && badUtf.reason, 'response_json_invalid');
  assert.equal((await callLocal(request(), jsonDeps({ choices: envelope().choices }))).kind, 'invalid_output');
  assert.equal((await callLocal(request(), jsonDeps({ ...envelope(), choices: [...envelope().choices, ...envelope().choices] }))).kind, 'invalid_output');
  const wrongArgs = envelope([{ ...call(), function: { name: 'propose_cart', arguments: { sku: 'book', qty: 1 } } }]);
  assert.equal((await callLocal(request(), jsonDeps(wrongArgs))).kind, 'invalid_output');
});
test('response evidence sink failure cannot return a successful call', async () => {
  const r = await callLocal(request(), { ...jsonDeps(envelope()), capture: e => { if (e.phase === 'response') throw Error('disk full'); } });
  assert.equal(r.kind, 'transport_error'); assert.equal('reason' in r && r.reason, 'capture_failed');
});
test('body read failure retains a bounded incomplete evidence prefix', async () => {
  let reads = 0;
  const events: Capture[] = [];
  const r = await callLocal(request(), {
    ...deps(async () => new Response(new ReadableStream({ pull(c) { if (reads++ === 0) c.enqueue(new Uint8Array([123])); else c.error(Error('broken')); } }))),
    capture: e => events.push(e),
  });
  assert.equal(r.kind, 'transport_error'); assert.equal(events[1]!.bytes.length, 1); assert.equal(events[1]!.complete, false);
});
