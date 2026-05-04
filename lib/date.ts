const JST_OFFSET_MIN = 9 * 60;

function toJstParts(d: Date): { year: number; month: number; day: number; weekday: number } {
  const utcMs = d.getTime();
  const jstMs = utcMs + JST_OFFSET_MIN * 60 * 1000;
  const jst = new Date(jstMs);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    weekday: jst.getUTCDay(),
  };
}

function jstDateUtc(year: number, month: number, day: number, hour = 0, min = 0, sec = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, min, sec, ms));
}

export interface DateRange { from: Date; to: Date; }

function weekendOf(saturdayDateInJst: { year: number; month: number; day: number }): DateRange {
  const { year, month, day } = saturdayDateInJst;
  const from = jstDateUtc(year, month, day, 0, 0, 0, 0);
  const sunday = new Date(from);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  const sundayJst = toJstParts(sunday);
  const to = jstDateUtc(sundayJst.year, sundayJst.month, sundayJst.day, 23, 59, 59, 999);
  return { from, to };
}

function nearestSaturdayJst(now: Date, weeksAhead: number): { year: number; month: number; day: number } {
  const { year, month, day, weekday } = toJstParts(now);
  let offset: number;
  if (weekday === 0) offset = -1;
  else if (weekday === 6) offset = 0;
  else offset = 6 - weekday;
  offset += 7 * weeksAhead;
  const saturday = jstDateUtc(year, month, day, 0, 0, 0, 0);
  saturday.setUTCDate(saturday.getUTCDate() + offset);
  return toJstParts(saturday);
}

export function getThisWeekend(now: Date = new Date()): DateRange {
  return weekendOf(nearestSaturdayJst(now, 0));
}

export function getNextWeekend(now: Date = new Date()): DateRange {
  return weekendOf(nearestSaturdayJst(now, 1));
}
