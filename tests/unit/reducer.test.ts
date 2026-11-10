import { it,expect } from 'vitest';
import { reduceCapture,reduceRefund } from '../../src/domain/ledger/state.ts';
import type { Refund,Reservation } from '../../src/shared/types.ts';
const r:Reservation={id:'r',ownerId:'o',mandateId:'m',policyVersion:1,policyHash:'h',periodKey:'p',restoration:'never_restore',state:'CAPTURING',amount:3999,holdMinor:3999,capturedMinor:0,externalRefundedMinor:0,orderId:'O',anomalyReasons:[],releaseOnResolve:false,createdAt:0,updatedAt:0};
const f:Refund={id:'f',captureId:'C',reservationId:'r',amount:1000,state:'SUBMITTING',completedApplied:false,providerRefundId:null,createdAt:0,updatedAt:0};
it('never re-reserves or releases a converted hold twice',()=>{
  const first=reduceCapture(r,3999,[],'C',1);expect(first.holdReleased).toBe(3999);
  const extra=reduceCapture(first.reservation,500,['C'],'C2',2);expect(extra.holdReleased).toBe(0);expect(extra.reservation.capturedMinor).toBe(4499);
  expect(reduceCapture(extra.reservation,500,['C','C2'],'C2',3).capturedAdded).toBe(0);
});
it('completion facts survive pending and failed observations, restore never occurs on request',()=>{
  expect(reduceRefund(f,'PENDING',true,1).restoredAdded).toBe(0);
  const completed=reduceRefund(f,'COMPLETED',true,2);
  expect(reduceRefund(completed.refund,'FAILED',true,3)).toMatchObject({completedAdded:0,restoredAdded:0,contradiction:true});
  expect(reduceRefund(completed.refund,'PENDING',true,3).refund.state).toBe('COMPLETED');
});
it('sensitivity: identical once-only accounting assertion detects removed completion guard',()=>{
  const completed=reduceRefund(f,'COMPLETED',true,1).refund;
  const assertOnce=(input:Refund)=>expect(reduceRefund(input,'COMPLETED',true,2).completedAdded).toBe(0);
  assertOnce(completed);expect(()=>assertOnce({...completed,completedApplied:false})).toThrow();
});
