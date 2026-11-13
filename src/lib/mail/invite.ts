import type { CalEvent } from "./model.ts";
import { describeRule, parseRRule } from "./recurrence.ts";

function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * A property's value: `NAME:value` or `NAME;PARAM=x;PARAM="a:b":value`. The value
 * is everything after the first colon outside quoted parameters, so a colon
 * inside the value (a title like "Q4 review: budget") is kept.
 */
function field(lines: string[], name: string): string {
  const pattern = new RegExp(`^${name}((?:;(?:"[^"]*"|[^:";])*)*):(.*)$`, "i");
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return (match[2] ?? "").trim().replace(/^mailto:/i, "").trim();
  }
  return "";
}

/** Offset (ms) of an IANA zone at a UTC instant, from Intl. Null for an unknown zone. */
function zoneOffset(zone: string, utcMs: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
  } catch {
    return null;
  }
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `zone` to a UTC instant (two passes cover DST edges). */
function zonedToUtc(wallMs: number, zone: string): number | null {
  const first = zoneOffset(zone, wallMs);
  if (first === null) return null;
  const second = zoneOffset(zone, wallMs - first);
  return wallMs - (second ?? first);
}

function whenLabel(line: string): { label: string; sort: string } {
  const value = line.replace(/^[^:]*(?:"[^"]*"[^:]*)*:/, "").trim();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return { label: value || line, sort: value || line };
  const [, y, mo, d, h = "00", mi = "00", sec = "00", z] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  const zone = /;TZID=("?)([^;:"]+)\1/i.exec(line)?.[2];
  // A floating or all-day time has no zone; it is shown as written, labelled UTC like before.
  const utc = !z && zone && match[4] !== undefined ? zonedToUtc(wall, zone) ?? wall : wall;
  const iso = new Date(utc).toISOString();
  return { label: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, sort: iso };
}

/** Read a single VEVENT from an invite body or a text/calendar part. */
export function parseInvite(text: string): CalEvent | null {
  if (!/BEGIN:VCALENDAR/i.test(text) || !/BEGIN:VEVENT/i.test(text)) return null;
  const lines = unfold(text);
  // A REPLY is someone's answer to an invite, not an invite.
  if (field(lines, "METHOD").toUpperCase() === "REPLY") return null;
  const title = field(lines, "SUMMARY");
  if (!title) return null;
  const start = lines.find((line) => line.toUpperCase().startsWith("DTSTART"));
  const when = whenLabel(start ?? "");
  const rawUid = field(lines, "UID");
  const uid = rawUid || title;
  const organizer = field(lines, "ORGANIZER");
  const rule = field(lines, "RRULE");
  const parsedRule = rule ? parseRRule(rule) : null;
  // EXDATE lines may repeat and hold comma-separated values; each keeps its line's TZID.
  const exdates: string[] = [];
  for (const line of lines.filter((item) => /^EXDATE[;:]/i.test(item))) {
    const params = line.slice(0, line.indexOf(":", line.search(/[;:]/)) + 1);
    const values = line.slice(params.length).split(",");
    for (const value of values) {
      const iso = whenLabel(`${params.replace(/:$/, "")}:${value.trim()}`).sort;
      if (/^\d{4}-\d{2}-\d{2}T/.test(iso)) exdates.push(iso);
    }
  }
  return {
    id: `ics-${uid.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "event"}`,
    title: title.slice(0, 200),
    whenLabel: parsedRule ? `${when.label} · ${describeRule(parsedRule)}` : when.label,
    where: field(lines, "LOCATION").slice(0, 200),
    with: organizer.slice(0, 200) || "Calendar invite",
    sort: when.sort,
    ...(parsedRule ? { rrule: rule.slice(0, 300) } : {}),
    ...(parsedRule && exdates.length ? { exdates: [...new Set(exdates)].slice(0, 100) } : {}),
    ...(rawUid ? { uid: rawUid.slice(0, 300) } : {}),
    ...(/^[^\s@]+@[^\s@]+$/.test(organizer) ? { organizer: organizer.toLowerCase().slice(0, 320) } : {}),
  };
}

export type PartStat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5546 iTIP REPLY for one attendee. CRLF lines, ready to put in a message body. */
export function buildReply(
  event: CalEvent,
  attendee: { name: string; email: string },
  partstat: PartStat,
  now = new Date(),
): string {
  if (!event.organizer || !event.uid) throw new Error("This invite has no organizer to answer.");
  const start = Date.parse(event.sort);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cumulus//Mail//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${event.uid.replace(/[\r\n]/g, "")}`,
    `DTSTAMP:${icsStamp(now)}`,
    ...(Number.isFinite(start) ? [`DTSTART:${icsStamp(new Date(start))}`] : []),
    `SUMMARY:${icsText(event.title)}`,
    `ORGANIZER:mailto:${event.organizer}`,
    `ATTENDEE;PARTSTAT=${partstat};CN="${attendee.name.replace(/["\r\n]/g, "")}":mailto:${attendee.email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Read an iTIP REPLY: who answered which event, and how. */
export function parseReply(text: string): { uid: string; attendee: string; partstat: PartStat } | null {
  if (!/BEGIN:VCALENDAR/i.test(text)) return null;
  const lines = unfold(text);
  if (field(lines, "METHOD").toUpperCase() !== "REPLY") return null;
  const line = lines.find((item) => /^ATTENDEE[;:]/i.test(item)) ?? "";
  const partstat = /;PARTSTAT=([A-Z-]+)/i.exec(line)?.[1]?.toUpperCase();
  if (partstat !== "ACCEPTED" && partstat !== "TENTATIVE" && partstat !== "DECLINED") return null;
  const uid = field(lines, "UID");
  const attendee = field(lines, "ATTENDEE").toLowerCase();
  if (!uid || !attendee.includes("@")) return null;
  return { uid, attendee, partstat };
}
