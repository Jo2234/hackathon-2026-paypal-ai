const DAY = 86_400_000;
const SGT_OFFSET = 8 * 3_600_000;
export type WeeklyPeriod = Readonly<{ periodKey: string; startsAt: number; endsAt: number }>;
// Singapore is UTC+08 without DST. Shift once, then use UTC fields consistently.
export function weeklyPeriod(now: number): WeeklyPeriod {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('INVALID_TIME');
  const shifted = new Date(now + SGT_OFFSET);
  const date = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const monday = date - ((shifted.getUTCDay() + 6) % 7) * DAY;
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
  const week = 1 + (monday - firstMonday) / (7 * DAY);
  return Object.freeze({ periodKey: `${year}-W${String(week).padStart(2, '0')}@Asia/Singapore`, startsAt: monday - SGT_OFFSET, endsAt: monday + 7 * DAY - SGT_OFFSET });
}
