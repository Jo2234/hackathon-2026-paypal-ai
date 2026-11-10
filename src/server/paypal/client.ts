import { EXPONENT, parseMinor } from '../../domain/money.ts';
import type { Currency } from '../../shared/types.ts';
import { assertUuidV4 } from '../../shared/canonical.ts';
import { sandboxApprovalUrl } from '../../shared/io-contracts.ts';
import type { Deadline } from '../../shared/io-contracts.ts';
import { SANDBOX_BASE } from '../env.ts';
import { object, resourceId, validateResource, ProviderError } from './provider.ts';
import type { PayPalProvider, PostCommand, ProviderResource, ResourceKind, CaptureResource } from './provider.ts';

export type SandboxConfig = Readonly<{clientId:string;clientSecret:string;merchantId:string;baseUrl?:string}>;
export type TransportEvidence = Readonly<{at:string;method:string;path:string;status:number;debugId:string|null;requestId:string|null}>;
// Injection is code-only, for offline HTTP tests; no URL/transport comes from a route or env.
export class SandboxPayPal implements PayPalProvider {
  readonly mode='sandbox' as const;
  readonly label='PAYPAL SANDBOX — synthetic catalogue; human buyer approval; GET reconciliation; Vault off';
  readonly merchantId:string;
  private admitGet:((path:string,purpose:NonNullable<Deadline['getPurpose']>)=>Promise<void>)|undefined;
  bindGetAdmission(admit:(path:string,purpose:NonNullable<Deadline['getPurpose']>)=>Promise<void>):void {this.admitGet=admit;}
  private token=''; private expires=0;
  private readonly config:SandboxConfig;
  private readonly transport:typeof fetch;
  private readonly evidence:(e:TransportEvidence)=>void;
  private readonly now:()=>number;
  constructor(config:SandboxConfig, transport:typeof fetch=fetch, evidence:(e:TransportEvidence)=>void=()=>{}, now=()=>performance.now()) {
    this.config=config;this.transport=transport;this.evidence=evidence;this.now=now;
    if(config.baseUrl!==undefined && config.baseUrl!==SANDBOX_BASE)throw new Error('SANDBOX_BASE_REQUIRED');
    if(!config.clientId || !config.clientSecret)throw new Error('SANDBOX_CONFIGURATION_REQUIRED');
    this.merchantId=resourceId(config.merchantId);
    if(this.merchantId==='demo-merchant')throw new Error('REAL_SANDBOX_MERCHANT_REQUIRED');
  }
  private async request(path:string,method:'GET'|'POST',body:string|undefined,headers:Record<string,string>,deadline:Deadline,requestId?:string):Promise<{body:Record<string,unknown>;debugId?:string}> {
    if(!/^\/v[12]\/[A-Za-z0-9/_-]+$/.test(path))throw new Error('SANDBOX_PATH_INVALID');
    const remaining=deadline.monotonicEndsAt-this.now();
    if(remaining<=0 || deadline.signal.aborted)throw new Error('PROVIDER_DEADLINE');
    const controller=new AbortController(),abort=()=>controller.abort();
    deadline.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,Math.min(remaining,20_000));
    try {
      if(method==='GET'){
        // Production fetch must have durable admission bound by the runtime or
        // acceptance runner. Only code-injected offline transports may omit it.
        if(!this.admitGet && this.transport===fetch)throw new Error('GET_DURABLE_ADMISSION_REQUIRED');
        await deadline.beforeGet?.();await this.admitGet?.(path,deadline.getPurpose??'foreground');
      }
      const r=await this.transport(SANDBOX_BASE+path,{method,headers,redirect:'error',signal:controller.signal,...(body===undefined?{}:{body})});
      const rawDebug=r.headers.get('paypal-debug-id');
      const debugId=rawDebug && /^[A-Za-z0-9-]{1,128}$/.test(rawDebug)?rawDebug:undefined;
      this.evidence({at:new Date().toISOString(),method,path,status:r.status,debugId:debugId??null,requestId:requestId??null});
      const reader=r.body?.getReader();if(!reader)throw new Error('PROVIDER_EMPTY_BODY');
      let length=0;const chunks:Uint8Array[]=[];
      try {while(true){const v=await reader.read();if(v.done)break;length+=v.value.length;if(length>1048576){await reader.cancel();throw new Error('PROVIDER_RESPONSE_CAP');}chunks.push(v.value);}}finally{reader.releaseLock();}
      if(!r.ok)throw new ProviderError(r.status,'PAYPAL_HTTP_ERROR');
      if(controller.signal.aborted)throw new Error('PROVIDER_DEADLINE');
      const value=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return {body:value,...(debugId?{debugId}:{})};
    } finally {clearTimeout(timer);deadline.signal.removeEventListener('abort',abort);}
  }
  private async auth(deadline:Deadline):Promise<string> {
    if(this.token && this.now()<this.expires)return this.token;
    const started=this.now();
    const r=await this.request('/v1/oauth2/token','POST','grant_type=client_credentials',{'authorization':`Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},deadline);
    if(typeof r.body['access_token']!=='string' || !r.body['access_token'] || r.body['token_type']!=='Bearer' || typeof r.body['expires_in']!=='number' || !Number.isFinite(r.body['expires_in']) || r.body['expires_in']<=0)throw new Error('PAYPAL_TOKEN_INVALID');
    this.token=r.body['access_token'];this.expires=started+Math.max(0,r.body['expires_in']*1000-30_000);return this.token;
  }
  private async api(path:string,method:'GET'|'POST',body:string|undefined,deadline:Deadline,requestId?:string) {
    // One logical request, at most two wire attempts: only a 401 permits replay.
    // Each GET attempt consumes admission and shares the original deadline.
    // A POST 401 replay is idempotent: identical persisted request ID and body.
    for(let attempt=0;attempt<2;attempt++) {
      const token=await this.auth(deadline);
      try {return await this.request(path,method,body,{authorization:`Bearer ${token}`,'content-type':'application/json',prefer:'return=representation',...(requestId?{'PayPal-Request-Id':requestId}:{})},deadline,requestId);}
      catch(e){if(!(e instanceof ProviderError) || e.status!==401 || attempt!==0)throw e;this.token='';this.expires=0;}
    }
    throw new Error('PAYPAL_AUTH_FAILED');
  }
  private async normalize(kind:ResourceKind,raw:Record<string,unknown>,deadline:Deadline,debugId?:string):Promise<ProviderResource> {
    const v:Record<string,unknown>={...raw,...(debugId?{debugId}:{})};
    if(kind==='order') {
      if(!Array.isArray(v['purchase_units']) || v['purchase_units'].length!==1)throw new Error('PROVIDER_ORDER_INVALID');
      const u=object(v['purchase_units'][0]);
      // Orders schema allows omitted or email-only payee. Neither proves the
      // configured merchant: no assumption that OAuth app ownership is the payee.
      if(!u['payee'] || object(u['payee'])['merchant_id']===undefined)throw new Error('PAYPAL_ORDER_MERCHANT_UNSUPPORTED');
      if(object(u['payee'])['merchant_id']!==this.merchantId)throw new Error('PROVIDER_MERCHANT_INVALID');
      const links=Array.isArray(v['links'])?v['links']:[];
      const link=links.map(object).find(l=>['approve','payer-action'].includes(String(l['rel'])));
      if(link)v['approvalUrl']=sandboxApprovalUrl(String(link['href']),resourceId(v['id']));
      // Embedded order completion is insufficient: independently GET every capture.
      const payments=u['payments']===undefined?undefined:object(u['payments']);
      if(payments){if(!Array.isArray(payments['captures']) || payments['captures'].length>20)throw new Error('PROVIDER_CAPTURES_INVALID');const captures:CaptureResource[]=[];
        for(const c of payments['captures']){const capture=await this.get('capture',resourceId(object(c)['id']),deadline) as CaptureResource;if(capture.supplementary_data.related_ids.order_id!==v['id'])throw new Error('PAYPAL_CAPTURE_ORDER_MISMATCH');captures.push(capture);}
        v['purchase_units']=[{...u,payments:{captures}}];
      }
    } else if(kind==='capture') {
      if(object(v['payee'])['merchant_id']!==this.merchantId)throw new Error('PROVIDER_MERCHANT_INVALID');
      // Refunded statuses retain original gross amount; only independently
      // authenticated refund resources may apply refund completion to the ledger.
    } else {
      const links=Array.isArray(v['links'])?v['links']:[];
      const up=links.map(object).find(l=>l['rel']==='up');
      if(!up)throw new Error('PAYPAL_REFUND_PARENT_MISSING');
      const url=new URL(String(up['href']));
      // PayPal emits both sandbox API hosts in HATEOAS. Extract identity only;
      // all transport still uses the fixed SANDBOX_BASE, never the link URL.
      if(![SANDBOX_BASE,'https://api.sandbox.paypal.com'].includes(url.origin) || url.search || url.hash || url.username || url.password || !/^\/v2\/payments\/captures\/[A-Za-z0-9-]+$/.test(url.pathname))throw new Error('PAYPAL_REFUND_PARENT_INVALID');
      v['supplementary_data']={related_ids:{capture_id:resourceId(url.pathname.split('/').at(-1))}};
    }
    return validateResource(kind,v,this.merchantId);
  }
  async post(command:PostCommand,deadline:Deadline):Promise<ProviderResource> {
    assertUuidV4(command.requestId);
    if(Buffer.byteLength(command.canonicalBody)>65536)throw new Error('PROVIDER_BODY_CAP');
    const kind=command.kind==='REFUND_CREATE'?'refund':'order';
    const path=command.kind==='ORDER_CREATE'?'/v2/checkout/orders':command.kind==='ORDER_CAPTURE'?`/v2/checkout/orders/${resourceId(command.resourceId)}/capture`:`/v2/payments/captures/${resourceId(command.resourceId)}/refund`;
    const r=await this.api(path,'POST',command.canonicalBody,deadline,command.requestId);
    const id=resourceId(r.body['id']);
    // Bounded protocol identity is retained BEFORE trusted ledger validation or GET.
    await deadline.onResourceId?.(id);
    if(kind==='order') {
      if(command.kind==='ORDER_CAPTURE' && id!==command.resourceId)throw new Error('PAYPAL_POST_ID_MISMATCH');
      const units=r.body['purchase_units'];
      const u=Array.isArray(units) && units.length===1?object(units[0]):undefined;
      if(!u || !u['payee'] || !object(u['payee'])['merchant_id'] || !u['amount'] || !u['custom_id'] || !u['invoice_id'])return this.get('order',id,deadline);
    }
    // Minimal refund responses are locators, never settlement facts. One logical
    // enrichment GET uses the original deadline/admission; a 401 may cause a
    // second admitted wire attempt. No enrichment failure resends the refund POST.
    const result=kind==='refund' && (r.body['amount']===undefined || !Array.isArray(r.body['links']) || !r.body['links'].some(l=>object(l)['rel']==='up'))
      ? await this.get('refund',id,deadline) : await this.normalize(kind,r.body,deadline,r.debugId);
    // Persisted locator above survives correlation failures for by-ID recovery.
    // Request fields are comparisons only, never replacement provider evidence.
    if(kind==='refund') {
      let expected:unknown;try {expected=object(JSON.parse(command.canonicalBody))['amount'];}catch {throw new Error('PAYPAL_REFUND_CORRELATION_MISMATCH');}
      assertRefundCorrelation(result,command.resourceId!,expected,id);
    }
    return result;
  }
  async get(kind:ResourceKind,id:string,deadline:Deadline):Promise<ProviderResource> {
    resourceId(id);const path=kind==='order'?`/v2/checkout/orders/${id}`:`/v2/payments/${kind==='capture'?'captures':'refunds'}/${id}`;
    const r=await this.api(path,'GET',undefined,deadline);
    if(r.body['id']!==id)throw new Error('PAYPAL_GET_ID_MISMATCH');
    return this.normalize(kind,r.body,deadline,r.debugId);
  }
}

// Correlation does not establish completion; callers must also require status.
// Parse exact integer minor units, never floating point or decimal-text equality.
export function assertRefundCorrelation(input:unknown,captureId:string,expected:unknown,refundId:string):void {
  try {
    const value=object(input),actual=object(value['amount']),wanted=object(expected);
    const currency=wanted['currency_code'];
    if(typeof currency!=='string' || !Object.hasOwn(EXPONENT,currency) || actual['currency_code']!==currency ||
      typeof actual['value']!=='string' || typeof wanted['value']!=='string' || value['id']!==refundId ||
      object(object(value['supplementary_data'])['related_ids'])['capture_id']!==captureId)throw new Error();
    const minor=parseMinor(wanted['value'],currency as Currency);
    if(minor<=0 || parseMinor(actual['value'],currency as Currency)!==minor)throw new Error();
  }catch {throw new Error('PAYPAL_REFUND_CORRELATION_MISMATCH');}
}

// Evidence stores only fixed diagnostic labels, never arbitrary exception text.
const codes=new Set([
 'PAYPAL_REFUND_CORRELATION_MISMATCH','PAYPAL_REFUND_PARENT_MISSING','PAYPAL_REFUND_PARENT_INVALID','PROVIDER_OBJECT_INVALID',
 'PROVIDER_AMOUNT_INVALID','PROVIDER_REFUND_INVALID','PROVIDER_CAPTURE_INVALID',
 'PROVIDER_ORDER_INVALID','PROVIDER_RESOURCE_ID_INVALID','PROVIDER_MERCHANT_INVALID',
 'PAYPAL_ORDER_MERCHANT_UNSUPPORTED','PAYPAL_CAPTURE_ORDER_MISMATCH','PAYPAL_POST_ID_MISMATCH',
 'PAYPAL_GET_ID_MISMATCH','PROVIDER_DEADLINE','PROVIDER_EMPTY_BODY','PROVIDER_RESPONSE_CAP',
 'PAYPAL_HTTP_ERROR','PAYPAL_TOKEN_INVALID','PAYPAL_AUTH_FAILED','GET_DURABLE_BUDGET',
 'GET_DURABLE_ADMISSION_REQUIRED','GET_RESOURCE_BUDGET_EXHAUSTED','GET_RESOURCE_HORIZON_EXHAUSTED',
 'GET_RESOURCE_CLOCK_ROLLBACK','PAYPAL_APPROVAL_LINK_MISSING','BUYER_NOT_APPROVED',
 'CAPTURE_ID_MISSING','CAPTURE_NOT_SETTLED','REFUND_NOT_COMPLETED_RECONCILE_BY_ID',
 'INTERACTIVE_BUYER_CONSENT_REQUIRED',
]);
export function sanitizedAcceptanceError(error:unknown):{class:string;code:string} {
 const kind=error instanceof ProviderError?'ProviderError':error instanceof SyntaxError?'SyntaxError':error instanceof TypeError?'TypeError':error instanceof Error?'Error':'Unknown';
 return {class:kind,code:error instanceof Error && codes.has(error.message)?error.message:'UNCLASSIFIED_ERROR'};
}
type Step={step:string;startedAt:string;completedAt?:string;failedAt?:string;status:'RUNNING'|'PASS'|'FAIL';error?:ReturnType<typeof sanitizedAcceptanceError>};
export async function acceptanceStep<T>(report:{steps:Step[];failure?:{step:string;at:string;error:ReturnType<typeof sanitizedAcceptanceError>}},save:()=>void,step:string,action:()=>Promise<T>):Promise<T> {
 const entry:Step={step,startedAt:new Date().toISOString(),status:'RUNNING'};
 report.steps.push(entry);save();
 try {const result=await action();entry.status='PASS';entry.completedAt=new Date().toISOString();save();return result;}
 catch(error){entry.status='FAIL';entry.failedAt=new Date().toISOString();entry.error=sanitizedAcceptanceError(error);report.failure={step,at:entry.failedAt,error:entry.error};save();throw error;}
}
