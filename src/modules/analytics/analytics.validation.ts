import { z } from 'zod';
const dayMs = 86400000;
export const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00.000Z');
    return (
      Number(v.slice(0, 4)) > 0 &&
      Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === v
    );
  }, 'Invalid calendar date');
export const rangeQuery = (maximumDays: number) =>
  z
    .object({ from: localDate.optional(), to: localDate.optional() })
    .refine(
      (q) => (!q.from && !q.to) || (!!q.from && !!q.to),
      'Choose both start and end dates',
    )
    .refine(
      (q) =>
        !q.from ||
        !q.to ||
        (q.from <= q.to &&
          (Date.parse(q.to) - Date.parse(q.from)) / dayMs < maximumDays),
      `Choose a valid range of at most ${maximumDays} days`,
    );
const dhakaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function clockParts(at: Date) {
  return Object.fromEntries(
    dhakaClock.formatToParts(at).map((p) => [p.type, p.value]),
  );
}
// Resolve calendar midnights with timezone data, including Dhaka's historic DST.
function midnight(day: string) {
  const local = Date.parse(day + 'T00:00:00.000Z');
  let utc = local;
  for (let i = 0; i < 4; i++) {
    const p = clockParts(new Date(utc));
    const represented = new Date(0);
    represented.setUTCFullYear(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
    );
    represented.setUTCHours(
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
      0,
    );
    const next = local - (represented.getTime() - utc);
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}
export function dateRange(
  query: { from?: string; to?: string },
  now = new Date(),
) {
  const p = clockParts(now);
  const today = `${p.year.padStart(4, '0')}-${p.month}-${p.day}`;
  const to = query.to ?? today;
  const from =
    query.from ??
    new Date(Date.parse(to) - 29 * dayMs).toISOString().split('T')[0];
  const followingDay = new Date(Date.parse(to) + dayMs)
    .toISOString()
    .split('T')[0];
  return {
    from,
    to,
    start: midnight(from),
    end: midnight(followingDay),
    timeZone: 'Asia/Dhaka' as const,
  };
}
export const overviewSchema = z.object({
  query: rangeQuery(90).safeExtend({}).strict(),
});
