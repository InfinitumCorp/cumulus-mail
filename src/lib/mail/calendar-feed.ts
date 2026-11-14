/**
 * A calendar subscription feed: a secret URL another calendar app (Apple Calendar, Google Calendar,
 * Outlook, Thunderbird) can subscribe to, so this mailbox's events appear there and stay current.
 *
 * - **Secret.** The URL carries a random 256-bit token. Only its SHA-256 is stored, so the table cannot
 *   be turned back into working URLs; the full URL is shown once, when it is made.
 * - **Rotatable.** Making a new one replaces the old: the old URL stops working at once. Turning the
 *   feed off removes it.
 * - **Read-only.** The feed answers GET with an iCalendar file and nothing else. It cannot change
 *   anything, and it holds only what a calendar needs: title, time, place, who, recurrence.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertTenantId } from "../storage/adapter.ts";
import type { CalEvent } from "./model.ts";
import type { MailQuery } from "./query.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** `cal_` and 32 random bytes, base64url. */
export function newFeedToken(): string {
  return `cal_${randomBytes(32).toString("base64url")}`;
}

/** Make a feed, or replace the existing one (rotation). Returns the token: the only time it is visible. */
export async function rotateFeed(db: MailQuery, tenantId: string, token = newFeedToken(), now = new Date()): Promise<string> {
  assertTenantId(tenantId);
  await db.query(
    `insert into cumulus_mail.calendar_feeds (tenant_id, token_sha256, created_at) values ($1, $2, $3)
     on conflict (tenant_id) do update set token_sha256 = excluded.token_sha256, created_at = excluded.created_at`,
    [tenantId, sha256(token), now.toISOString()],
  );
  return token;
}

export async function disableFeed(db: MailQuery, tenantId: string): Promise<boolean> {
  assertTenantId(tenantId);
  const rows = await db.query<{ tenant_id: string }>(
    `delete from cumulus_mail.calendar_feeds where tenant_id = $1 returning tenant_id`,
    [tenantId],
  );
  return rows.length > 0;
}

export async function feedStatus(db: MailQuery, tenantId: string): Promise<{ enabled: boolean; createdAt: string | null }> {
  assertTenantId(tenantId);
  const rows = await db.query<{ created_at: string | Date }>(
    `select created_at from cumulus_mail.calendar_feeds where tenant_id = $1`,
    [tenantId],
  );
  return { enabled: rows.length > 0, createdAt: rows[0] ? new Date(rows[0].created_at).toISOString() : null };
}

/** Whose feed a token opens, or null. Looked up by hash, re-checked in constant time. */
export async function feedTenant(db: MailQuery, token: string): Promise<string | null> {
  if (!/^cal_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const hash = sha256(token);
  const rows = await db.query<{ tenant_id: string; token_sha256: string }>(
    `select tenant_id, token_sha256 from cumulus_mail.calendar_feeds where token_sha256 = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  const a = Buffer.from(row.token_sha256, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row.tenant_id : null;
}

/* ---------------- iCalendar ---------------- */

/** RFC 5545 TEXT escaping. */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 §3.1: at most 75 octets per line, continued with CRLF + space, never inside a character. */
export function foldIcs(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * The feed. Events this mailbox **declined** are left out; tentative ones are marked tentative.
 * Cumulus events carry a start but no end yet, so each is one hour long in the feed.
 */
export function feedIcs(events: CalEvent[], name: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cumulus//Mail calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    // Ask subscribers to refresh hourly; clients treat this as a hint.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const event of events) {
    const start = Date.parse(event.sort);
    if (!Number.isFinite(start) || event.rsvp === "declined") continue;
    const uid = (event.uid ?? `${event.id}@cumulus-mail`).replace(/[\r\n]/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(new Date(start))}`,
      "DURATION:PT1H",
      `SUMMARY:${icsText(event.title)}`,
      ...(event.where ? [`LOCATION:${icsText(event.where)}`] : []),
      ...(event.with ? [`DESCRIPTION:${icsText(`With ${event.with}`)}`] : []),
      ...(event.rrule && /^[A-Z0-9=;,:+-]+$/i.test(event.rrule) ? [`RRULE:${event.rrule}`] : []),
      ...(event.exdates ?? []).filter((d) => Number.isFinite(Date.parse(d))).map((d) => `EXDATE:${stamp(new Date(d))}`),
      ...(event.rdates ?? []).filter((d) => Number.isFinite(Date.parse(d))).map((d) => `RDATE:${stamp(new Date(d))}`),
      ...(event.rsvp === "tentative" ? ["STATUS:TENTATIVE"] : ["STATUS:CONFIRMED"]),
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcs).join("\r\n")}\r\n`;
}
