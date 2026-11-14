/**
 * RFC 5545 RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, and
 *   - BYDAY: weekly MO..SU; monthly MO..SU with an optional ordinal (2TU, -1FR); yearly the same
 *     within each BYMONTH month (4TH in November), or within the whole year without BYMONTH (20MO);
 *   - BYMONTH (1..12): which months, for YEARLY; a filter for the other frequencies;
 *   - BYMONTHDAY (1..31, -1..-31 from the end): which days, for MONTHLY and YEARLY (a filter for DAILY).
 *     With BYDAY as well, a day must match both (Friday the 13th: BYDAY=FR;BYMONTHDAY=13).
 * Without BY* parts a series keeps the start's weekday, day of month or date, and a date a month or
 * year does not have (the 31st, 29 February) is skipped, as RFC 5545 says. RDATE is calendar.ts's.
 * Times are UTC instants; expansion keeps the start's time of day.
 */
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type RRule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  /** ISO instant, inclusive. */
  until?: string;
  byDay: { day: Weekday; ordinal?: number }[];
  /** 1..12. */
  byMonth: number[];
  /** 1..31 or -1..-31 (counted from the month's end). */
  byMonthDay: number[];
};

const DAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES: Record<Weekday, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

/** Hard cap on generated occurrences, so a bad rule cannot loop for long. */
export const MAX_OCCURRENCES = 500;

function untilIso(value: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  // A date-only UNTIL includes that whole day.
  const ms = h === undefined ? Date.UTC(+y!, +mo! - 1, +d!, 23, 59, 59) : Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!, +s!);
  return new Date(ms).toISOString();
}

/** Parse an RRULE value (with or without the `RRULE:` prefix). Unsupported rules return null. */
export function parseRRule(value: string): RRule | null {
  const body = value.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const parts = new Map<string, string>();
  for (const part of body.split(";")) {
    const [key, val] = part.split("=");
    if (key && val !== undefined) parts.set(key.trim().toUpperCase(), val.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const interval = Math.max(1, Math.min(1000, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1));
  const countRaw = parts.get("COUNT");
  const count = countRaw ? Math.max(1, Math.min(MAX_OCCURRENCES, Number.parseInt(countRaw, 10) || 1)) : undefined;
  const until = parts.get("UNTIL") ? untilIso(parts.get("UNTIL")!) : undefined;
  if (parts.get("UNTIL") && !until) return null;
  const list = (name: string) => (parts.get(name) ?? "").split(",").filter(Boolean);
  const byMonth: number[] = [];
  for (const item of list("BYMONTH")) {
    const month = Number(item);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    byMonth.push(month);
  }
  const byMonthDay: number[] = [];
  for (const item of list("BYMONTHDAY")) {
    const day = Number(item);
    if (!Number.isInteger(day) || day === 0 || Math.abs(day) > 31) return null;
    byMonthDay.push(day);
  }
  // RFC 5545: BYMONTHDAY MUST NOT be used with WEEKLY.
  if (byMonthDay.length && freq === "WEEKLY") return null;
  // An ordinal counts weeks in a month (up to 5), or in a year (up to 53) for YEARLY without BYMONTH.
  const maxOrdinal = freq === "YEARLY" && !byMonth.length ? 53 : 5;
  const byDay: RRule["byDay"] = [];
  for (const item of list("BYDAY")) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
    if (!match) return null;
    const ordinal = match[1] ? Number.parseInt(match[1], 10) : undefined;
    if (ordinal !== undefined && (ordinal === 0 || Math.abs(ordinal) > maxOrdinal)) return null;
    byDay.push({ day: match[2] as Weekday, ordinal });
  }
  return { freq, interval, count, until, byDay, byMonth: [...new Set(byMonth)].sort((a, b) => a - b), byMonthDay: [...new Set(byMonthDay)] };
}

function startOfWeekUtc(ms: number): number {
  // Weeks start on Monday (RFC 5545 default WKST=MO).
  const date = new Date(ms);
  const offset = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
}

function nthWeekdayOfMonth(year: number, month: number, day: Weekday, ordinal: number): number | null {
  const target = DAYS.indexOf(day);
  if (ordinal > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const date = 1 + ((target - first + 7) % 7) + (ordinal - 1) * 7;
    const ms = Date.UTC(year, month, date);
    return new Date(ms).getUTCMonth() === month ? ms : null;
  }
  const lastDate = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, lastDate)).getUTCDay();
  const date = lastDate - ((last - target + 7) % 7) + (ordinal + 1) * 7;
  return date >= 1 ? Date.UTC(year, month, date) : null;
}

const DAY_MS = 86_400_000;

/** Midnight (UTC, ms) of each day in `month` the rule picks: BYMONTHDAY and/or BYDAY, else the start's day of month. */
function monthDays(year: number, month: number, rule: RRule, startDate: number): number[] {
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weekday = (ms: number) => DAYS[new Date(ms).getUTCDay()]!;
  let days: number[];
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay
      .map((n) => (n > 0 ? n : length + n + 1))
      .filter((date) => date >= 1 && date <= length)
      .map((date) => Date.UTC(year, month, date));
    // With BYDAY as well, a day must also be one of those weekdays.
    if (rule.byDay.length) days = days.filter((ms) => rule.byDay.some((item) => item.day === weekday(ms)));
  } else if (rule.byDay.length) {
    days = [];
    for (const item of rule.byDay) {
      if (item.ordinal !== undefined) {
        const ms = nthWeekdayOfMonth(year, month, item.day, item.ordinal);
        if (ms !== null) days.push(ms);
      } else {
        for (let date = 1; date <= length; date += 1) {
          const ms = Date.UTC(year, month, date);
          if (weekday(ms) === item.day) days.push(ms);
        }
      }
    }
  } else {
    // Same day of month; months without it (e.g. the 31st) are skipped.
    days = startDate <= length ? [Date.UTC(year, month, startDate)] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Midnight (UTC, ms) of each BYDAY day in a whole year: every such weekday, or the nth (20MO, -1FR). */
function yearWeekdays(year: number, byDay: RRule["byDay"]): number[] {
  const out: number[] = [];
  for (const item of byDay) {
    const all: number[] = [];
    for (let ms = Date.UTC(year, 0, 1); new Date(ms).getUTCFullYear() === year; ms += DAY_MS) {
      if (DAYS[new Date(ms).getUTCDay()] === item.day) all.push(ms);
    }
    if (item.ordinal === undefined) out.push(...all);
    else {
      const ms = item.ordinal > 0 ? all[item.ordinal - 1] : all[all.length + item.ordinal];
      if (ms !== undefined) out.push(ms);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Occurrence start times (ISO) from `startIso`, in order. The start itself is
 * always the first occurrence. Stops at COUNT, UNTIL, `limit`, or `before`.
 */
export function occurrences(startIso: string, rule: RRule, options: { limit?: number; before?: string } = {}): string[] {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return [];
  const limit = Math.min(options.limit ?? MAX_OCCURRENCES, rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const stop = Math.min(rule.until ? Date.parse(rule.until) : Infinity, options.before ? Date.parse(options.before) : Infinity);
  const timeOfDay = start - Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  const out: number[] = [];
  const push = (ms: number) => {
    if (ms < start || ms > stop || out.length >= limit) return;
    if (!out.includes(ms)) out.push(ms);
  };
  push(start);
  const base = new Date(start);
  const inMonths = (ms: number) => !rule.byMonth.length || rule.byMonth.includes(new Date(ms).getUTCMonth() + 1);
  for (let step = 0; out.length < limit && step < 5000; step += 1) {
    let candidates: number[] = [];
    if (rule.freq === "YEARLY") {
      const year = base.getUTCFullYear() + step * rule.interval;
      if (Date.UTC(year, 0, 1) > stop) break;
      if (rule.byMonth.length || rule.byMonthDay.length) {
        // BYMONTH picks the months (all twelve when only BYMONTHDAY is given); then the days in each.
        const months = rule.byMonth.length ? rule.byMonth.map((m) => m - 1) : [...Array(12).keys()];
        for (const month of months) candidates.push(...monthDays(year, month, rule, base.getUTCDate()));
      } else if (rule.byDay.length) {
        candidates = yearWeekdays(year, rule.byDay);
      } else {
        // The start's month and day; 29 February only exists in leap years, other years are skipped.
        const ms = Date.UTC(year, base.getUTCMonth(), base.getUTCDate());
        if (new Date(ms).getUTCMonth() === base.getUTCMonth()) candidates = [ms];
      }
      candidates = candidates.sort((a, b) => a - b).map((ms) => ms + timeOfDay);
    } else if (rule.freq === "DAILY") {
      const ms = start + (step + 1) * rule.interval * DAY_MS;
      const date = new Date(ms).getUTCDate();
      const length = new Date(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth() + 1, 0)).getUTCDate();
      const dayOk = !rule.byMonthDay.length || rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === date);
      const weekdayOk = !rule.byDay.length || rule.byDay.some((item) => item.day === DAYS[new Date(ms).getUTCDay()]);
      if (inMonths(ms) && dayOk && weekdayOk) candidates = [ms];
      else if (ms > stop) break;
      else continue;
    } else if (rule.freq === "WEEKLY") {
      const week = startOfWeekUtc(start) + step * rule.interval * 7 * DAY_MS;
      const days = rule.byDay.length ? rule.byDay.map((item) => item.day) : [DAYS[base.getUTCDay()]!];
      candidates = days
        .map((day) => week + ((DAYS.indexOf(day) + 6) % 7) * DAY_MS + timeOfDay)
        .filter(inMonths)
        .sort((a, b) => a - b);
      if (!candidates.length) {
        if (week > stop) break;
        continue;
      }
    } else {
      const monthIndex = base.getUTCMonth() + step * rule.interval;
      const year = base.getUTCFullYear() + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      if (!rule.byMonth.length || rule.byMonth.includes(month + 1)) {
        candidates = monthDays(year, month, rule, base.getUTCDate()).map((ms) => ms + timeOfDay);
      } else if (Date.UTC(year, month, 1) > stop) break;
    }
    const first = candidates[0];
    if (first !== undefined && first > stop) break;
    for (const ms of candidates) push(ms);
  }
  return out.sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st, 22nd. */
function nth(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "last", "2nd to last" for negatives; "3rd" for positives. */
function position(n: number): string {
  return n === -1 ? "last" : n < 0 ? `${nth(-n)} to last` : nth(n);
}

/** Short human text, e.g. "Every 2 weeks on Mon, Wed · 10 times" or "Every year on 4th Thu in Nov". */
export function describeRule(rule: RRule): string {
  const unit = rule.freq === "DAILY" ? "day" : rule.freq === "WEEKLY" ? "week" : rule.freq === "MONTHLY" ? "month" : "year";
  let text = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  const on: string[] = [];
  if (rule.byMonthDay.length) {
    on.push(rule.byMonthDay.map((n) => (n === -1 ? "the last day" : n < 0 ? `the ${position(n)} day` : `the ${nth(n)}`)).join(", "));
  }
  if (rule.byDay.length) {
    on.push(rule.byDay.map((item) => `${item.ordinal !== undefined ? `${position(item.ordinal)} ` : ""}${DAY_NAMES[item.day]}`).join(", "));
  }
  if (on.length) text += ` on ${on.join(" if a ")}`;
  if (rule.byMonth.length) text += ` in ${rule.byMonth.map((m) => MONTH_NAMES[m - 1]).join(", ")}`;
  if (rule.count) text += ` · ${rule.count} times`;
  if (rule.until) text += ` · until ${rule.until.slice(0, 10)}`;
  return text;
}
