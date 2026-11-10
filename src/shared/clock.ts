import { performance } from 'node:perf_hooks';
export type ServerClock = Readonly<{ wallNow:()=>number; monotonicNow:()=>number }>;
export const systemClock:ServerClock=Object.freeze({wallNow:()=>Date.now(),monotonicNow:()=>performance.now()});
export function serverNow(clock:ServerClock):number {
  const now=clock.wallNow();if(!Number.isSafeInteger(now))throw new Error('SERVER_CLOCK_INVALID');return now;
}
