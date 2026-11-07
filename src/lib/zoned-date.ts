/** Calendar dates in a member's IANA timezone (P-24), for follow-ups and Today (§6.4). */

const DIGITS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const;

/** The wall-clock fields of `at` in `timeZone`. */
function partsIn(timeZone: string, at: Date) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, ...DIGITS });
  const parts = Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  );
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

/** True for a timezone name Intl accepts. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date, YYYY-MM-DD, that `at` falls on in `timeZone`. */
export function dateIn(timeZone: string, at = new Date()): string {
  const { year, month, day } = partsIn(timeZone, at);
  return [year, month, day].map((part) => String(part).padStart(2, '0')).join('-');
}

/** The first instant of calendar date `date` (YYYY-MM-DD) in `timeZone`, as epoch milliseconds. */
function startOf(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall;
  // Two passes settle the offset, also across a daylight saving change on that day.
  for (let pass = 0; pass < 2; pass += 1) {
    const local = partsIn(timeZone, new Date(instant));
    const asUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    instant = wall - (asUtc - instant);
  }
  return instant;
}

/** `end(D)` (§6.4): the last instant of `date` in `timeZone`, as an ISO timestamp. */
export function endOfDate(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return new Date(startOf(next, timeZone) - 1).toISOString();
}

/** Whole calendar days from the local date of `at` to `date`, both in `timeZone`. */
export function daysBetween(at: string, date: string, timeZone: string): number {
  const from = Date.parse(`${dateIn(timeZone, new Date(at))}T00:00:00Z`);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - from) / 86_400_000);
}
