import { describe,it,expect } from 'vitest';
import fc from 'fast-check';
import { EXPONENT,addMinor,formatMinor,multiplyMinor,parseMinor } from '../../src/domain/money.ts';
import { weeklyPeriod } from '../../src/domain/ledger/period.ts';
import type { Currency } from '../../src/shared/types.ts';
describe('Integer money (10k property cases)',()=>{
  it('rejects precision, coercion and out-of-range instead of rounding',()=>{
    expect(parseMinor('0.29','USD')).toBe(29);
    for(const value of ['0.001','1e3','Infinity','NaN',' 1','01','1.','10000000000.01'])expect(()=>parseMinor(value,'USD')).toThrow();
    for(const currency of ['JPY','HUF','TWD'] as const)expect(()=>parseMinor('1.0',currency)).toThrow();
    expect(()=>addMinor(1000000000000,1)).toThrow();expect(multiplyMinor(999,3)).toBe(2997);
  });
  it('roundtrips all supported exponents without floating arithmetic',()=>{
    fc.assert(fc.property(fc.constantFrom<Currency>('USD','EUR','SGD','JPY','HUF','TWD'),fc.integer({min:-1000000000000,max:1000000000000}),(currency,minor)=>{
      const output=formatMinor(minor,currency);expect(parseMinor(output,currency)).toBe(minor);
      expect((output.split('.')[1]||'').length).toBe(EXPONENT[currency]);
    }),{numRuns:10000,seed:190026});
  });
  it('uses SGT Monday and ISO week year',()=>{
    expect(weeklyPeriod(Date.parse('2026-10-18T15:59:59Z')).periodKey).toBe('2026-W42@Asia/Singapore');
    expect(weeklyPeriod(Date.parse('2026-10-18T16:00:00Z')).periodKey).toBe('2026-W43@Asia/Singapore');
    expect(weeklyPeriod(Date.parse('2020-12-31T16:00:00Z')).periodKey).toBe('2020-W53@Asia/Singapore');
    expect(weeklyPeriod(Date.parse('2021-01-03T16:00:00Z')).periodKey).toBe('2021-W01@Asia/Singapore');
  });
  describe('sensitivity',()=>{it('detects float conversion against same exact-minor expectation',()=>{
    const assertExact=(parse:(value:string)=>number)=>expect(parse('0.29')).toBe(29);
    assertExact(value=>parseMinor(value,'USD'));
    expect(()=>assertExact(value=>parseFloat(value)*100)).toThrow();
  });});
});
