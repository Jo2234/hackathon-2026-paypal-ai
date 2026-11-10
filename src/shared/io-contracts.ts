// S2 contracts only; no network, server, listener, resolver, session or reconciler here.
import type { FactEvidence } from './types.ts';
export type Deadline = Readonly<{ monotonicEndsAt:number; signal:AbortSignal; getPurpose?:'foreground'|'automatic'|'manual'|'callback'; beforeGet?:()=>Promise<void>; onResourceId?:(id:string)=>Promise<void> }>;
export type BoundedTransportRequest = Readonly<{ method:'GET'|'POST'; url:string; deadline:Deadline; byteCap:number; attempts:1; redirects:0; body?:string }>;
export type VerifiedEventEnqueue = Readonly<{ verifiedDeliverySeq:number; eventId:string; bodyHash:string; resourceType:'order'|'capture'|'refund'; resourceId:string }>;
// Verified event insert AND unique resource job enqueue must be one IMMEDIATE transaction.
// INVALID deliveries never occupy webhook_events.event_id. Payload cannot mutate money.
export type VerifiedEventResult = 'enqueued'|'durable_duplicate'|'quarantined_conflict';
export type AuthoritativeObservationSource = Readonly<{ kind:'authenticated_post_response'|'correlated_get'; evidence:FactEvidence }>;
export type MaintenanceFence = Readonly<{ token:string; leaseUntil:number; cursor:string }>;
// Every job mutation must match the live fence. Expired readers may submit observations only.
export type ReconcileBatch = Readonly<{ scanned:number; getAttempts:number; deferred:number; cursor:string; outcome:'done'|'deadline'|'cancelled' }>;
export type SessionBoundary = Readonly<{ expectedHost:string; expectedOrigin:string; csrfNonce:string; generation:string; absoluteEndsAt:number; idleEndsAt:number }>;
export type CapabilityStatus = 'drafted_unrun'|'local fixture verified'|'live integration implemented but unverified'|'live integration verified'|'final release gate';

// Official Orders examples use https://www.sandbox.paypal.com/checkoutnow?token=ORDER_ID.
// The same retained official schema also documents /app-switch-checkout.
// Additional query/path formats require verification before being admitted.
export function sandboxApprovalUrl(value:string,orderId:string):string {
  const url=new URL(value);
  if(url.protocol!=='https:' || !['www.sandbox.paypal.com','sandbox.paypal.com'].includes(url.hostname) || url.username || url.password || url.port || !['/checkoutnow','/app-switch-checkout'].includes(url.pathname) || url.hash || url.searchParams.getAll('token').length!==1 || url.searchParams.get('token')!==orderId || [...url.searchParams.keys()].some(k=>k!=='token'))throw new Error('PAYPAL_APPROVAL_URL_INVALID');
  return url.href;
}
