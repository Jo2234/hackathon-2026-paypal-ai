import type { ServerClock } from '../../src/shared/clock.ts';
export class TestClock implements ServerClock {
  wall:number;mono=0;
  constructor(wall:number){this.wall=wall;}
  wallNow=()=>this.wall;
  monotonicNow=()=>this.mono;
  advance(wallMs:number,monoMs=wallMs):void {this.wall+=wallMs;this.mono+=monoMs;}
}
export function fixedClock(wall:number):ServerClock{return {wallNow:()=>wall,monotonicNow:()=>0};}
