import { createAcceptanceCheckout } from './sandbox-checkout-return.mjs';
import { acceptanceStep, sanitizedAcceptanceError, assertRefundCorrelation } from '../src/server/paypal/client.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { SandboxPayPal } from '../src/server/paypal/client.ts';
import { loadSandboxEnv, sandboxConfig } from '../src/server/paypal/config.ts';
import { readModes } from '../src/server/env.ts';
const root=new URL('../../',import.meta.url);
const directory=new URL('evidence/sandbox/',root);
mkdirSync(directory,{recursive:true});
const path=new URL(`acceptance-${Date.now()}.json`,directory);
const report={status:'UNRUN',startedAt:new Date().toISOString(),calls:[],steps:[],requestIds:{},getAdmissions:{},limitation:'Direct real transport acceptance; does not prove browser or ledger end-to-end integration.'};
const step=(name,action)=>acceptanceStep(report,save,name,action);
const save=()=>writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
let landing;
const interruption=new AbortController();
const interrupt=()=>interruption.abort(new Error('INTERRUPTED_RECONCILE_BY_ID'));
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const lifetime=setTimeout(interrupt,15*60*1000);lifetime.unref();
try {
 loadSandboxEnv();
 if(!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_MERCHANT_ID){report.reason='Set SANDBOX_ENV_FILE explicitly or export PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MERCHANT_ID as explicit environment configuration; no calls attempted';save();console.log(`UNRUN: ${report.reason}. Evidence: ${path.pathname}`);process.exitCode=2;}
 else {
  readModes({...process.env,PAYPAL_MODE:'sandbox'});
  if(!process.stdin.isTTY)throw new Error('INTERACTIVE_BUYER_CONSENT_REQUIRED');
  const provider=new SandboxPayPal(sandboxConfig(process.env),fetch,e=>{report.calls.push(e);save();});
  provider.bindGetAdmission(async path=>{
    const now=Date.now(),prior=report.getAdmissions[path];
    if(prior && (prior.attempts>=24 || now<prior.lastAt || now-prior.started>=86400000))throw new Error('GET_DURABLE_BUDGET');
    report.getAdmissions[path]={started:prior?.started??now,lastAt:now,attempts:(prior?.attempts??0)+1};save();
  });
  const deadline=()=>({signal:interruption.signal,monotonicEndsAt:performance.now()+60000});
  const id=randomUUID(),amount={currency_code:'USD',value:'1.00'};
  const post=async(kind,resourceId,body)=>{const requestId=randomUUID();report.requestIds[kind]=requestId;report.status='RUNNING';save();return provider.post({kind,resourceId,requestId,canonicalBody:JSON.stringify(body)},{...deadline(),onResourceId:async id=>{report[kind==='REFUND_CREATE'?'refundId':'orderId']=id;save();}});};
  landing=await createAcceptanceCheckout({signal:interruption.signal});
  interruption.signal.throwIfAborted();
  const order=await step('create',()=>post('ORDER_CREATE',null,landing.body(id,provider.merchantId,amount)));
  landing.bindOrder(order.id);
  report.orderId=order.id;save();
  if(!order.approvalUrl)throw new Error('PAYPAL_APPROVAL_LINK_MISSING');
  console.log(`Sandbox buyer approval required: ${order.approvalUrl}`);
  interruption.signal.throwIfAborted();
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  terminal.on('SIGINT',interrupt);
  try {await terminal.question('Approve with a sandbox personal buyer, then press Enter. Ctrl-C retains evidence; do not rerun an unknown payment. ',{signal:interruption.signal});}finally{terminal.close();}
  landing.assertNotCancelled();
  interruption.signal.throwIfAborted();
  await step('approve-check',async()=>{const approved=await provider.get('order',order.id,deadline());
  if(approved.status!=='APPROVED')throw new Error('BUYER_NOT_APPROVED');});
  landing.assertNotCancelled();
  const cap=await step('capture',async()=>{const paid=await post('ORDER_CAPTURE',order.id,{});
  const cap=paid.purchase_units[0].payments?.captures[0];
  if(!cap)throw new Error('CAPTURE_ID_MISSING');report.captureId=cap.id;save();return cap;});
  await step('capture-settle',async()=>{const settled=await provider.get('capture',cap.id,deadline());
  if(settled.status!=='COMPLETED' || settled.amount.value!=='1.00' || settled.amount.currency_code!=='USD')throw new Error('CAPTURE_NOT_SETTLED');});
  const refund=await step('refund',()=>post('REFUND_CREATE',cap.id,{amount}));report.refundId=refund.id;save();
  await step('refund-get',async()=>{const confirmed=await provider.get('refund',refund.id,deadline());
  assertRefundCorrelation(confirmed,cap.id,amount,refund.id);
  if(confirmed.status!=='COMPLETED')throw new Error('REFUND_NOT_COMPLETED_RECONCILE_BY_ID');});
  report.status='PASS';report.completedAt=new Date().toISOString();save();console.log(`PASS: ${path.pathname}`);
 }
} catch(error) {report.failure??={step:'setup-or-approval',at:new Date().toISOString(),error:sanitizedAcceptanceError(error)};report.status=report.calls.length?'INCOMPLETE_UNKNOWN_RECONCILE_BY_ID':'UNRUN';report.reason='Acceptance incomplete; no raw provider error or credentials recorded. Inspect IDs and reconcile, never assume failure or resend.';save();console.error(`${report.status}: ${path.pathname}`);process.exitCode=1;}

finally {await landing?.close();clearTimeout(lifetime);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
