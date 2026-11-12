import type { CalEvent } from "./model.ts";

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

function whenLabel(raw: string): { label: string; sort: string } {
  const stamp = raw.replace(/^.*:/, "").replace(/Z$/, "");
  const match = stamp.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!match) return { label: raw, sort: raw };
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? "00"}:${match[5] ?? "00"}:00.000Z`;
  return { label: `${match[1]}-${match[2]}-${match[3]} ${match[4] ?? "00"}:${match[5] ?? "00"} UTC`, sort: iso };
}

/** Read a single VEVENT from an invite body or a text/calendar part. */
export function parseInvite(text: string): CalEvent | null {
  if (!/BEGIN:VCALENDAR/i.test(text) || !/BEGIN:VEVENT/i.test(text)) return null;
  const lines = unfold(text);
  const title = field(lines, "SUMMARY");
  if (!title) return null;
  const start = lines.find((line) => line.toUpperCase().startsWith("DTSTART"));
  const when = whenLabel(start ?? "");
  const uid = field(lines, "UID") || title;
  return {
    id: `ics-${uid.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "event"}`,
    title: title.slice(0, 200),
    whenLabel: when.label,
    where: field(lines, "LOCATION").slice(0, 200),
    with: field(lines, "ORGANIZER").slice(0, 200) || "Calendar invite",
    sort: when.sort,
  };
}
