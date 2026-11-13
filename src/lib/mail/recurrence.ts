/**
 * RFC 5545 RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
 * BYDAY (weekly: MO..SU; monthly: MO..SU with an optional ordinal like 2TU or -1FR).
 * YEARLY repeats the start's month and day (a 29 February start skips other years);
 * YEARLY with BYDAY is not supported.
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
  const byDay: RRule["byDay"] = [];
  for (const item of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
    if (!match || freq === "YEARLY") return null;
    const ordinal = match[1] ? Number.parseInt(match[1], 10) : undefined;
    if (ordinal !== undefined && (ordinal === 0 || Math.abs(ordinal) > 5)) return null;
    byDay.push({ day: match[2] as Weekday, ordinal });
  }
  return { freq, interval, count, until, byDay };
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
  for (let step = 0; out.length < limit && step < 5000; step += 1) {
    let candidates: number[] = [];
    if (rule.freq === "YEARLY") {
      const base = new Date(start);
      const year = base.getUTCFullYear() + (step + 1) * rule.interval;
      const ms = Date.UTC(year, base.getUTCMonth(), base.getUTCDate());
      // 29 February only exists in leap years; other years are skipped, as RFC 5545 says.
      if (new Date(ms).getUTCMonth() === base.getUTCMonth()) candidates = [ms + timeOfDay];
      else continue;
    } else if (rule.freq === "DAILY") {
      candidates = [start + (step + 1) * rule.interval * 86_400_000];
    } else if (rule.freq === "WEEKLY") {
      const week = startOfWeekUtc(start) + step * rule.interval * 7 * 86_400_000;
      const days = rule.byDay.length ? rule.byDay.map((item) => item.day) : [DAYS[new Date(start).getUTCDay()]!];
      candidates = days
        .map((day) => week + ((DAYS.indexOf(day) + 6) % 7) * 86_400_000 + timeOfDay)
        .sort((a, b) => a - b);
    } else {
      const base = new Date(start);
      const monthIndex = base.getUTCMonth() + step * rule.interval;
      const year = base.getUTCFullYear() + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      if (rule.byDay.length) {
        for (const item of rule.byDay) {
          if (item.ordinal !== undefined) {
            const ms = nthWeekdayOfMonth(year, month, item.day, item.ordinal);
            if (ms !== null) candidates.push(ms + timeOfDay);
          } else {
            const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
            for (let date = 1; date <= days; date += 1) {
              const ms = Date.UTC(year, month, date);
              if (DAYS[new Date(ms).getUTCDay()] === item.day) candidates.push(ms + timeOfDay);
            }
          }
        }
        candidates.sort((a, b) => a - b);
      } else {
        // Same day of month; months without it (e.g. the 31st) are skipped, as RFC 5545 says.
        const ms = Date.UTC(year, month, base.getUTCDate());
        if (new Date(ms).getUTCMonth() === month) candidates = [ms + timeOfDay];
      }
    }
    const first = candidates[0];
    if (first !== undefined && first > stop) break;
    for (const ms of candidates) push(ms);
  }
  return out.sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/** Short human text, e.g. "Every 2 weeks on Mon, Wed · 10 times". */
export function describeRule(rule: RRule): string {
  const unit = rule.freq === "DAILY" ? "day" : rule.freq === "WEEKLY" ? "week" : rule.freq === "MONTHLY" ? "month" : "year";
  let text = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  if (rule.byDay.length) {
    const ordinal = (n: number) => (n === -1 ? "last " : n > 0 ? `${["", "1st", "2nd", "3rd", "4th", "5th"][n]} ` : `${n} `);
    text += ` on ${rule.byDay.map((item) => `${item.ordinal !== undefined ? ordinal(item.ordinal) : ""}${DAY_NAMES[item.day]}`).join(", ")}`;
  }
  if (rule.count) text += ` · ${rule.count} times`;
  if (rule.until) text += ` · until ${rule.until.slice(0, 10)}`;
  return text;
}
