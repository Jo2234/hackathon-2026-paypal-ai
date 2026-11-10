import type { AnomalyReason, Reservation, Refund, RefundState } from '../../shared/types.ts';
import { addMinor, assertMinor } from '../money.ts';
export const ACTIVE_REFUND_STATES: readonly RefundState[] = ['REQUESTED','SUBMITTING','PROVIDER_PENDING','REFUND_UNKNOWN'];
export type CaptureReduction = Readonly<{ reservation: Reservation; holdReleased: number; capturedAdded: number; reasons: readonly AnomalyReason[] }>;
export function reduceCapture(reservation: Reservation, amount: number, priorCompletedIds: readonly string[], captureId: string, now: number): CaptureReduction {
  assertMinor(amount, true);
  if (amount === 0) throw new Error('CAPTURE_POSITIVE');
  if (priorCompletedIds.includes(captureId)) return { reservation, holdReleased: 0, capturedAdded: 0, reasons: [] };
  const reasons: AnomalyReason[] = [];
  if (priorCompletedIds.length > 0) reasons.push('UNKNOWN_CAPTURE_ID');
  if (reservation.state === 'RELEASED') reasons.push('CAPTURE_AFTER_RELEASE');
  if (priorCompletedIds.length === 0 && amount > reservation.amount) reasons.push('CAPTURE_OVER_HOLD');
  const updated = { ...reservation, state: 'CAPTURED' as const, holdMinor: 0, capturedMinor: addMinor(reservation.capturedMinor, amount), anomalyReasons: [...new Set([...reservation.anomalyReasons,...reasons])], updatedAt: now };
  return { reservation: updated, holdReleased: reservation.holdMinor, capturedAdded: amount, reasons };
}
export function reduceRelease(reservation: Reservation, captureClaimed: boolean, now: number): Reservation {
  if (captureClaimed || reservation.capturedMinor > 0) return reservation;
  return { ...reservation, state: 'RELEASED', holdMinor: 0, releaseOnResolve: true, updatedAt: now };
}
export type RefundReduction = Readonly<{ refund: Refund; completedAdded: number; restoredAdded: number; contradiction: boolean }>;
export function reduceRefund(refund: Refund, status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', restore: boolean, now: number): RefundReduction {
  if (refund.completedApplied) return { refund, completedAdded: 0, restoredAdded: 0, contradiction: status === 'FAILED' || status === 'CANCELLED' };
  const contradiction = (refund.state === 'FAILED' || refund.state === 'CANCELLED') && status === 'COMPLETED';
  if (status === 'COMPLETED') return { refund: { ...refund, state: 'COMPLETED', completedApplied: true, updatedAt: now }, completedAdded: refund.amount, restoredAdded: restore ? refund.amount : 0, contradiction };
  if (refund.state === 'FAILED' || refund.state === 'CANCELLED') return { refund, completedAdded: 0, restoredAdded: 0, contradiction: status !== refund.state && status !== 'PENDING' };
  const state: RefundState = status === 'PENDING' ? 'PROVIDER_PENDING' : status;
  return { refund: { ...refund, state, updatedAt: now }, completedAdded: 0, restoredAdded: 0, contradiction: false };
}
export function refundHeadroom(captured: number, completedLocal: number, completedExternal: number, commitments: number): number {
  for (const amount of [captured,completedLocal,completedExternal,commitments]) assertMinor(amount, true);
  return addMinor(captured, -completedLocal, -completedExternal, -commitments);
}
