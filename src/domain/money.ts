import type { Currency, Money } from '../shared/types.ts';
export const MONEY_BOUND = 1_000_000_000_000;
export const EXPONENT: Readonly<Record<Currency, 0 | 2>> = Object.freeze({ USD: 2, EUR: 2, SGD: 2, JPY: 0, HUF: 0, TWD: 0 });
export function assertMinor(value: number, nonnegative = false): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MONEY_BOUND || (nonnegative && value < 0)) throw new Error('MONEY_RANGE');
  return value;
}
function bounded(value: bigint): number {
  if (value < -1_000_000_000_000n || value > 1_000_000_000_000n) throw new Error('MONEY_RANGE');
  return Number(value); // only bounded integer BigInt, never a decimal amount string
}
export function addMinor(...values: readonly number[]): number { return bounded(values.reduce((sum, n) => sum + BigInt(assertMinor(n)), 0n)); }
export function multiplyMinor(minor: number, qty: number): number {
  assertMinor(minor);
  if (!Number.isSafeInteger(qty)) throw new Error('QUANTITY_INTEGER');
  return bounded(BigInt(minor) * BigInt(qty));
}
export function parseMinor(text: string, currency: Currency): number {
  const exponent = EXPONENT[currency];
  if (exponent === undefined || text.length > 32 || !(exponent === 0 ? /^-?(?:0|[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/).test(text)) throw new Error('MONEY_FORMAT');
  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(whole) * (exponent === 0 ? 1n : 100n) + (exponent === 0 ? 0n : BigInt(fraction.padEnd(2, '0')));
  return bounded(negative ? -value : value);
}
export function formatMinor(minor: number, currency: Currency): string {
  assertMinor(minor);
  const exponent = EXPONENT[currency];
  if (exponent === undefined) throw new Error('CURRENCY');
  const absolute = BigInt(minor < 0 ? -minor : minor);
  return `${minor < 0 ? '-' : ''}${exponent === 0 ? absolute : `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`}`;
}
export function money(currency: Currency, minor: number): Money { return Object.freeze({ currency, minor: assertMinor(minor) }); }
export function sumMoney(values: readonly Money[], currency: Currency): Money {
  if (values.some(value => value.currency !== currency)) throw new Error('CURRENCY_MISMATCH');
  return money(currency, addMinor(...values.map(value => value.minor)));
}
