import { assertUuidV4, canonicalJson } from '../../shared/canonical.ts';
import type { Deadline } from '../../shared/io-contracts.ts';
import type { OperationKind } from '../../shared/types.ts';
import { amount, object, ProviderError, resourceId, validateResource, FIXTURE_LABEL } from './provider.ts';
import type { CaptureResource, FixtureProvider, OrderResource, PostCommand, ProviderResource, RefundResource, ResourceKind } from './provider.ts';
import { parseMinor } from '../../domain/money.ts';

export type FakeOutcome = 'success'|'response_loss_after_commit'|'5xx'|'PENDING'|'DECLINED';
// Handwritten, doc-shaped fixture semantics; not a provider retention/atomicity guarantee.
// Counter increments BEFORE dedupe. Duplicate transport calls remain observable.
export class FakePayPal implements FixtureProvider {
  readonly mode='fixture' as const;
  readonly merchantId='demo-merchant';
  readonly label=FIXTURE_LABEL;
  readonly clock: ()=>number;
  readonly retentionMs: number;
  private sequence=0;
  private invocationCount=0;
  private getCount=0;
  private readonly resources=new Map<string,ProviderResource>();
  private readonly dedupe=new Map<string,{at:number;body:string;resource:ProviderResource}>();
  private readonly outcomes=new Map<OperationKind,FakeOutcome[]>();
  constructor(options: Readonly<{now?:()=>number;idempotencyExpiryMs?:number}>={}) {
    this.clock=options.now??(()=>Date.now()); this.retentionMs=options.idempotencyExpiryMs??Infinity;
    if(this.retentionMs<0 || Number.isNaN(this.retentionMs)) throw new Error('FIXTURE_RETENTION_INVALID');
  }
  get transportInvocations(): number { return this.invocationCount; }
  get getInvocations(): number { return this.getCount; }
  plan(kind: OperationKind, outcomes: readonly FakeOutcome[]): void {
    if(outcomes.length>20 || outcomes.some(x=>!['success','response_loss_after_commit','5xx','PENDING','DECLINED'].includes(x))) throw new Error('FIXTURE_PLAN_CAP');
    this.outcomes.set(kind,[...outcomes]);
  }
  private check(deadline: Deadline): void {
    if(deadline.signal.aborted || performance.now()>=deadline.monotonicEndsAt) throw new Error('PROVIDER_DEADLINE');
  }
  private next(prefix:string): string { if(this.resources.size>=1000) throw new ProviderError(503,'FIXTURE_RESOURCE_CAP'); return `${prefix}-${++this.sequence}`; }
  async post(command: PostCommand, deadline: Deadline): Promise<ProviderResource> {
    this.invocationCount++; this.check(deadline); assertUuidV4(command.requestId);
    if(Buffer.byteLength(command.canonicalBody)>65536) throw new Error('FIXTURE_BODY_CAP');
    const input=object(JSON.parse(command.canonicalBody));
    const key=canonicalJson([command.kind,command.resourceId,command.requestId]);
    const prior=this.dedupe.get(key);
    if(prior && this.clock()-prior.at<this.retentionMs) {
      if(prior.body!==command.canonicalBody) throw new ProviderError(422,'REQUEST_ID_BODY_MISMATCH');
      return structuredClone(prior.resource);
    }
    if(this.dedupe.size>=1000 && !prior) throw new ProviderError(503,'FIXTURE_DEDUPE_CAP');
    const outcome=this.outcomes.get(command.kind)?.shift()??'success';
    if(outcome==='5xx') throw new ProviderError(503,'FIXTURE_INTERNAL_ERROR');
    let result: ProviderResource;
    if(command.kind==='ORDER_CREATE') {
      if(input['intent']!=='CAPTURE' || !Array.isArray(input['purchase_units']) || input['purchase_units'].length!==1) throw new ProviderError(422,'ORDER_BODY_INVALID');
      const u=object(input['purchase_units'][0]);
      if(object(u['payee'])['merchant_id']!=='demo-merchant' || u['custom_id']!==u['invoice_id']) throw new ProviderError(422,'ORDER_CORRELATION_INVALID');
      const value=amount(u['amount']);if(value.currency_code!=='USD'||parseMinor(value.value,'USD')<=0)throw new ProviderError(422,'ORDER_AMOUNT_INVALID');
      result={id:this.next('ORDER'),status:'CREATED',purchase_units:[{custom_id:resourceId(u['custom_id']),invoice_id:resourceId(u['invoice_id']),payee:{merchant_id:'demo-merchant'},amount:amount(u['amount'])}]};
      this.resources.set(`order:${result.id}`,result);
    } else if(command.kind==='ORDER_CAPTURE') {
      const order=this.resources.get(`order:${resourceId(command.resourceId)}`) as OrderResource|undefined;
      if(!order || order.status!=='APPROVED') throw new ProviderError(422,'ORDER_NOT_APPROVED');
      if(Object.keys(input).length) throw new ProviderError(422,'CAPTURE_BODY_INVALID');
      const capture:CaptureResource={id:this.next('CAPTURE'),status:outcome==='PENDING'?'PENDING':outcome==='DECLINED'?'DECLINED':'COMPLETED',amount:order.purchase_units[0]!.amount,supplementary_data:{related_ids:{order_id:order.id}}};
      this.resources.set(`capture:${capture.id}`,capture);
      result={...order,status:capture.status==='COMPLETED'?'COMPLETED':'APPROVED',purchase_units:[{...order.purchase_units[0]!,payments:{captures:[capture]}}]};
      this.resources.set(`order:${order.id}`,result);
    } else {
      const capture=this.resources.get(`capture:${resourceId(command.resourceId)}`) as CaptureResource|undefined;
      if(!capture || capture.status!=='COMPLETED') throw new ProviderError(422,'CAPTURE_NOT_COMPLETED');
      const value=amount(input['amount']);if(value.currency_code!=='USD'||parseMinor(value.value,'USD')<=0)throw new ProviderError(422,'REFUND_AMOUNT_INVALID');
      const refund:RefundResource={id:this.next('REFUND'),status:outcome==='PENDING'?'PENDING':outcome==='DECLINED'?'FAILED':'COMPLETED',amount:amount(input['amount']),supplementary_data:{related_ids:{capture_id:capture.id}}};
      result=refund;this.resources.set(`refund:${refund.id}`,refund);
    }
    this.dedupe.set(key,{at:this.clock(),body:command.canonicalBody,resource:structuredClone(result)});
    if(outcome==='response_loss_after_commit') throw new Error('FIXTURE_RESPONSE_LOST_AFTER_COMMIT');
    return structuredClone(result);
  }
  async get(kind: ResourceKind, id: string, deadline: Deadline): Promise<ProviderResource> {
    this.getCount++;this.check(deadline); const result=this.resources.get(`${kind}:${resourceId(id)}`);
    if(!result) throw new ProviderError(404,'FIXTURE_RESOURCE_NOT_FOUND');
    return structuredClone(result);
  }
  approve(id:string):void {
    const key=`order:${resourceId(id)}`,order=this.resources.get(key) as OrderResource|undefined;
    if(!order) throw new ProviderError(404,'FIXTURE_RESOURCE_NOT_FOUND');
    if(order.status==='CREATED') this.resources.set(key,{...order,status:'APPROVED'});
  }
  // Offline scenario driver only. Never exposed as a verified flag or money route.
  setStatus(kind:'capture'|'refund',id:string,status:string):void {
    const key=`${kind}:${resourceId(id)}`,prior=this.resources.get(key);
    if(!prior) throw new ProviderError(404,'FIXTURE_RESOURCE_NOT_FOUND');
    const next=validateResource(kind,{...prior,status}, this.merchantId); this.resources.set(key,next);
    if(kind==='capture') {
      const c=next as CaptureResource,order=this.resources.get(`order:${c.supplementary_data.related_ids.order_id}`) as OrderResource;
      this.resources.set(`order:${order.id}`,{...order,status:c.status==='COMPLETED'?'COMPLETED':'APPROVED',purchase_units:[{...order.purchase_units[0]!,payments:{captures:[c]}}]});
    }
  }
}
