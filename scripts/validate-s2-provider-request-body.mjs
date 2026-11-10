// Tiny authorized pure check: no DB, Hono/app/native imports, child, network or model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakePayPal } from '../src/server/paypal/fake.ts';
import { LocalSession, deadlineScope, readBody, readJson } from '../src/server/session.ts';
import { canonicalJson } from '../src/shared/canonical.ts';
const watchdog=setTimeout(()=>{process.stderr.write('pure check exceeded 25s\n');process.exit(124);},25000);
let checks=0;
try {
  const parent=new AbortController(),deadline={signal:parent.signal,monotonicEndsAt:performance.now()+2000};
  let now=Date.parse('2026-10-19T01:00:00Z');
  const fake=new FakePayPal({now:()=>now,idempotencyExpiryMs:1000});
  const command={kind:'ORDER_CREATE',resourceId:null,requestId:randomUUID(),canonicalBody:canonicalJson({intent:'CAPTURE',purchase_units:[{custom_id:'reservation-1',invoice_id:'reservation-1',payee:{merchant_id:'demo-merchant'},amount:{currency_code:'USD',value:'17.50'}}]})};
  const order=await fake.post(command,deadline);
  assert.deepEqual(await fake.post(command,deadline),order);assert.equal(fake.transportInvocations,2);checks++;
  now+=1001;const extra=await fake.post(command,deadline);assert.notEqual(extra.id,order.id);assert.equal(fake.transportInvocations,3);checks++;
  fake.approve(order.id);
  fake.plan('ORDER_CAPTURE',['PENDING']);
  const captureCommand={kind:'ORDER_CAPTURE',resourceId:order.id,requestId:randomUUID(),canonicalBody:'{}'};
  const pending=await fake.post(captureCommand,deadline),capture=pending.purchase_units[0].payments.captures[0];
  assert.equal(capture.status,'PENDING');fake.setStatus('capture',capture.id,'COMPLETED');
  assert.equal((await fake.get('order',order.id,deadline)).status,'COMPLETED');checks++;
  fake.plan('REFUND_CREATE',['PENDING']);
  const refund=await fake.post({kind:'REFUND_CREATE',resourceId:capture.id,requestId:randomUUID(),canonicalBody:canonicalJson({amount:{currency_code:'USD',value:'1.00'}})},deadline);
  assert.equal(refund.status,'PENDING');fake.setStatus('refund',refund.id,'COMPLETED');assert.equal((await fake.get('refund',refund.id,deadline)).status,'COMPLETED');checks++;
  fake.plan('ORDER_CREATE',['response_loss_after_commit','5xx']);
  const lost={...command,requestId:randomUUID()};await assert.rejects(fake.post(lost,deadline),/LOST_AFTER_COMMIT/);
  const recovered=await fake.post(lost,deadline);assert.equal(recovered.status,'CREATED'); // Demonstrates fake dedupe only, NOT a permitted local retry.
  await assert.rejects(fake.post({...command,requestId:randomUUID()},deadline),/INTERNAL_ERROR/);checks++;
  fake.approve(extra.id);fake.plan('ORDER_CAPTURE',['DECLINED']);
  const declined=await fake.post({...captureCommand,resourceId:extra.id,requestId:randomUUID()},deadline);assert.equal(declined.purchase_units[0].payments.captures[0].status,'DECLINED');checks++;
  await assert.rejects(fake.get('order','unknown',deadline),e=>e.status===404);checks++;
  const clock={wallNow:()=>now,monotonicNow:()=>performance.now()},session=new LocalSession('127.0.0.1:8787',clock),origin='http://127.0.0.1:8787';
  const bootReq=new Request(`${origin}/api/session`,{headers:{host:'127.0.0.1:8787',origin}}),boot=session.bootstrap(bootReq);
  const headers={host:'127.0.0.1:8787',origin,cookie:boot.cookie.split(';')[0],'x-csrf-nonce':boot.csrfNonce,'idempotency-key':randomUUID(),'content-type':'application/json'};
  const request=()=>new Request(`${origin}/api/test`,{method:'POST',headers,body:'{}'});
  assert.ok(session.authorize(request(),true).expiresAt>now);checks++;
  for(const [name,value] of [['host','localhost:8787'],['origin','null'],['x-csrf-nonce','bad'],['cookie',''],['sec-fetch-site','cross-site']]) {
    assert.throws(()=>session.authorize(new Request(`${origin}/api/test`,{method:'POST',headers:{...headers,[name]:value},body:'{}'}),true));checks++;
  }
  const state=session.returnState('r','o');assert.ok(session.verifyReturn('r','o',state));assert.equal(session.verifyReturn('r','other',state),false);checks++;
  assert.deepEqual(await readJson(request(),deadline),{});checks++;
  await assert.rejects(readBody(new Request(`${origin}/api/test`,{method:'POST',body:'12345'}),deadline,4),/BODY_CAP/);checks++;
  await assert.rejects(readBody(new Request(`${origin}/api/test`,{method:'POST',headers:{'content-length':'9999'},body:'x'}),deadline,4),/BODY_CAP/);checks++;
  let cancelled=false;
  const slow=new Request(`${origin}/api/test`,{method:'POST',body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'});
  const scope=deadlineScope(parent.signal,performance.now()+10);
  try {await assert.rejects(readBody(slow,scope),/DEADLINE/);assert.ok(cancelled);checks++;} finally {scope.close();}
  now+=1800000;assert.throws(()=>session.authorize(request(),true),/SESSION_EXPIRED/);checks++;
  process.stdout.write(JSON.stringify({status:'PASS',scope:'new pure fixture provider + local boundary + bounded request-body only',checks,transportInvocations:fake.transportInvocations})+'\n');
} finally {clearTimeout(watchdog);}
