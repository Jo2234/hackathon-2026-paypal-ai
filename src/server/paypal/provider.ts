import type { Deadline } from '../../shared/io-contracts.ts';
import type { OperationKind } from '../../shared/types.ts';
import { canonicalJson } from '../../shared/canonical.ts';

export const FIXTURE_LABEL = 'SIMULATED PAYPAL APPROVAL — FIXTURE (no PayPal calls)';
export type Amount = Readonly<{ currency_code: string; value: string }>;
export type CaptureResource = Readonly<{ debugId?:string; id: string; status: 'COMPLETED'|'PENDING'|'DECLINED'|'REFUNDED'|'PARTIALLY_REFUNDED'; amount: Amount; supplementary_data: { related_ids: { order_id: string } } }>;
export type RefundResource = Readonly<{ debugId?:string; id: string; status: 'COMPLETED'|'PENDING'|'FAILED'|'CANCELLED'; amount: Amount; supplementary_data: { related_ids: { capture_id: string } } }>;
export type OrderResource = Readonly<{ approvalUrl?:string; debugId?:string; id: string; status: 'CREATED'|'SAVED'|'PAYER_ACTION_REQUIRED'|'VOIDED'|'APPROVED'|'COMPLETED'; purchase_units: readonly Readonly<{ custom_id: string; invoice_id: string; payee: { merchant_id: string }; amount: Amount; payments?: { captures: readonly CaptureResource[] } }>[] }>;
export type ProviderResource = OrderResource|CaptureResource|RefundResource;
export type ResourceKind = 'order'|'capture'|'refund';
export type PostCommand = Readonly<{ kind: OperationKind; resourceId: string|null; requestId: string; canonicalBody: string }>;
// Fixture-only interface. There is deliberately no default/global fetch implementation.
export interface PayPalProvider {
  bindGetAdmission?(admit:(path:string,purpose:NonNullable<Deadline['getPurpose']>)=>Promise<void>):void;
  readonly merchantId: string;
  readonly label: string;
  readonly mode: 'fixture'|'sandbox';
  post(command: PostCommand, deadline: Deadline): Promise<ProviderResource>;
  get(kind: ResourceKind, id: string, deadline: Deadline): Promise<ProviderResource>;
  approve?(id: string): void;
}
// Backwards compatible fixture test surface.
export interface FixtureProvider extends PayPalProvider { readonly mode:'fixture'; approve(id:string):void; }
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, name: string) { super(name.slice(0,120)); this.status=status; }
}
export function resourceId(value: unknown): string {
  if(typeof value!=='string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) throw new Error('PROVIDER_RESOURCE_ID_INVALID');
  return value;
}
export function object(value: unknown): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('PROVIDER_OBJECT_INVALID');
  return value as Record<string,unknown>;
}
export function amount(value: unknown): Amount {
  const v=object(value);
  // Preserve bounded foreign/out-of-range facts for the S1 quarantine reducer.
  if(typeof v['currency_code']!=='string' || v['currency_code'].length>64 || typeof v['value']!=='string' || v['value'].length>512) throw new Error('PROVIDER_AMOUNT_INVALID');
  return {currency_code:v['currency_code'],value:v['value']};
}
export function validateResource(kind: ResourceKind, input: unknown, merchantId: string): ProviderResource {
  if(Buffer.byteLength(canonicalJson(input))>1048576) throw new Error('PROVIDER_RESPONSE_CAP');
  const v=object(input),id=resourceId(v['id']);
  if(kind==='order') {
    if(!['CREATED','SAVED','PAYER_ACTION_REQUIRED','VOIDED','APPROVED','COMPLETED'].includes(String(v['status'])) || !Array.isArray(v['purchase_units']) || v['purchase_units'].length!==1) throw new Error('PROVIDER_ORDER_INVALID');
    const u=object(v['purchase_units'][0]);
    if(object(u['payee'])['merchant_id']!==merchantId) throw new Error('PROVIDER_MERCHANT_INVALID');
    const payments=u['payments']===undefined?undefined:object(u['payments']);
    if(payments && (!Array.isArray(payments['captures']) || payments['captures'].length>20)) throw new Error('PROVIDER_CAPTURES_INVALID');
    const captures=payments?(payments['captures'] as unknown[]).map(c=>validateResource('capture',c, merchantId) as CaptureResource):undefined;
    return {...(typeof v['approvalUrl']==='string'?{approvalUrl:v['approvalUrl']}:{}),...(typeof v['debugId']==='string'?{debugId:v['debugId']}:{}),id,status:v['status'] as OrderResource['status'],purchase_units:[{custom_id:resourceId(u['custom_id']),invoice_id:resourceId(u['invoice_id']),payee:{merchant_id:merchantId},amount:amount(u['amount']),...(captures?{payments:{captures}}:{})}]};
  }
  const related=object(object(v['supplementary_data'])['related_ids']);
  if(kind==='capture') {
    if(!['COMPLETED','PENDING','DECLINED','REFUNDED','PARTIALLY_REFUNDED'].includes(String(v['status']))) throw new Error('PROVIDER_CAPTURE_INVALID');
    return {...(typeof v['debugId']==='string'?{debugId:v['debugId']}:{}),id,status:v['status'] as CaptureResource['status'],amount:amount(v['amount']),supplementary_data:{related_ids:{order_id:resourceId(related['order_id'])}}};
  }
  if(!['COMPLETED','PENDING','FAILED','CANCELLED'].includes(String(v['status']))) throw new Error('PROVIDER_REFUND_INVALID');
  return {...(typeof v['debugId']==='string'?{debugId:v['debugId']}:{}),id,status:v['status'] as RefundResource['status'],amount:amount(v['amount']),supplementary_data:{related_ids:{capture_id:resourceId(related['capture_id'])}}};
}
