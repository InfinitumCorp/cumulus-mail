import { mailDomain } from "./domain.ts";
import {
  ME,
  type BoxId,
  type DeliveryHop,
  type MailMessage,
  type MailRule,
  type Person,
} from "./model.ts";
import { isCustomFolderId } from "./folders.ts";

export function isCumulus(email: string, domain = mailDomain()): boolean {
  return email.toLowerCase().endsWith(`@${domain}`);
}

export function isE2E(message: MailMessage): boolean {
  const people = [message.from, ...message.to, ...message.cc];
  return people.length > 0 && people.every((p) => isCumulus(p.email));
}

export function audienceLabel(people: Person[]): "Personal" | "External" {
  return people.length > 0 && people.every((person) => isCumulus(person.email)) ? "Personal" : "External";
}

export function isSnoozed(message: MailMessage, now = Date.now()): boolean {
  if (!message.snoozeUntil || message.folder === "trash" || message.folder === "drafts") return false;
  const at = Date.parse(message.snoozeUntil);
  return Number.isFinite(at) && at > now;
}

export function inBox(message: MailMessage, box: BoxId, now = Date.now()): boolean {
  if (box === "snoozed") return isSnoozed(message, now);
  if (isSnoozed(message, now)) return false;
  if (box === "outbox") {
    return message.folder === "sent" && (message.delivery ?? []).some((hop) => hop.status === "outbound");
  }
  if (box === "starred") return message.starred && message.folder !== "trash";
  return message.folder === box;
}

export function applyRules(message: MailMessage, rules: MailRule[]): MailMessage {
  if (message.folder !== "inbox") return message;
  let next = message;
  for (const rule of rules) {
    const needle = rule.from.trim().toLowerCase();
    if (!needle) continue;
    if (!`${next.from.name} ${next.from.email}`.toLowerCase().includes(needle)) continue;
    if (rule.action === "star") next = { ...next, starred: true };
    if (rule.action === "archive") next = { ...next, folder: "archive", unread: false };
    if (rule.action === "label") {
      const label = rule.label?.trim();
      if (label && !next.labels.includes(label)) next = { ...next, labels: [...next.labels, label] };
    }
  }
  return next;
}

export function withSignature(body: string, signature: string): string {
  const sig = signature.trim();
  if (!sig || body.includes(sig)) return body;
  const marker = "\n\n—\n";
  const cut = body.indexOf(marker);
  if (cut >= 0) return `${body.slice(0, cut).trimEnd()}\n\n${sig}${body.slice(cut)}`;
  return `${body.trimEnd()}\n\n${sig}`;
}

export function archiveThreads(messages: MailMessage[], threadIds: string[]): MailMessage[] {
  const ids = new Set(threadIds);
  return messages.map((message) =>
    ids.has(message.threadId) && (message.folder === "inbox" || isCustomFolderId(message.folder))
      ? { ...message, folder: "archive", unread: false }
      : message,
  );
}

export function trashThreads(messages: MailMessage[], threadIds: string[]): MailMessage[] {
  const ids = new Set(threadIds);
  return messages.map((message) =>
    ids.has(message.threadId) && message.folder !== "drafts" && message.folder !== "trash"
      ? { ...message, folder: "trash", unread: false }
      : message,
  );
}

export function markThreadUnread(messages: MailMessage[], threadId: string, meEmail: string = ME.email): MailMessage[] {
  const mine = meEmail.toLowerCase();
  const received = messages
    .filter((message) => message.threadId === threadId && message.from.email.toLowerCase() !== mine && message.folder !== "trash")
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const target = received ?? messages.filter((message) => message.threadId === threadId).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (!target) return messages;
  return messages.map((message) => (message.id === target.id ? { ...message, unread: true } : message));
}

export function emptyTrash(messages: MailMessage[]): MailMessage[] {
  return messages.filter((message) => message.folder !== "trash");
}

export function tomorrowMorning(now = new Date()): string {
  const until = new Date(now);
  until.setUTCDate(until.getUTCDate() + 1);
  until.setUTCHours(8, 0, 0, 0);
  return until.toISOString();
}

/**
 * Dates are written in English ("Tue 03 Nov, 16:48"; the interface translator turns them into Russian)
 * in `timeZone`: UTC on the server and in the first render, so the hydrated page matches; the viewer's
 * own zone after that (src/lib/viewer-time-zone.ts).
 */
export function formatWhen(iso: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function formatShort(iso: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

/** The zone after a time: "UTC", or the offset at that moment ("GMT+3", "GMT-5"), which needs no translation. */
export function zoneLabel(iso: string, timeZone = "UTC"): string {
  if (timeZone === "UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")?.value;
  return !part || /^GMT([+-]0)?$/.test(part) ? "UTC" : part;
}

/**
 * A calendar label that starts with its own start time in UTC ("2026-11-26 17:00 UTC · Every week"),
 * with that time in `timeZone` instead ("2026-11-26 20:00 GMT+3 · Every week"). Labels written any other
 * way (an invite's own text) are left as they are.
 */
export function localWhenLabel(label: string, sortIso: string, timeZone = "UTC"): string {
  const ms = Date.parse(sortIso);
  if (timeZone === "UTC" || !Number.isFinite(ms)) return label;
  const iso = new Date(ms).toISOString();
  const utcPrefix = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  if (!label.startsWith(utcPrefix)) return label;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zoneLabel(iso, timeZone)}${label.slice(utcPrefix.length)}`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "•";
}

export function planDelivery(people: Person[], options?: { password?: boolean }): DeliveryHop[] {
  const seen = new Set<string>();
  const hops: DeliveryHop[] = [];
  for (const person of people) {
    const email = person.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const outside = options?.password
      ? "Password-protected. External delivery stays in the outbox until a mail transport is configured."
      : "Held in the outbox. This preview does not send outside Cumulus.";
    hops.push(
      isCumulus(email)
        ? { email, status: "inside", detail: "Delivered inside Cumulus. End-to-end." }
        : { email, status: "outbound", detail: outside },
    );
  }
  return hops;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one-line preview the message list renders. */
export function messageSnippet(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function haystack(message: MailMessage): string {
  const files = (message.attachments ?? []).map((file) => file.name);
  return [
    message.subject,
    message.body,
    message.from.name,
    message.from.email,
    ...message.to.flatMap((person) => [person.name, person.email]),
    ...message.cc.flatMap((person) => [person.name, person.email]),
    ...message.labels,
    ...files,
  ]
    .join("\n")
    .toLowerCase();
}

function tokenMatches(message: MailMessage, token: string): boolean {
  if (token.startsWith("from:")) {
    const needle = token.slice(5);
    return !needle || `${message.from.name} ${message.from.email}`.toLowerCase().includes(needle);
  }
  if (token.startsWith("to:")) {
    const needle = token.slice(3);
    const people = [...message.to, ...message.cc];
    return !needle || people.some((person) => `${person.name} ${person.email}`.toLowerCase().includes(needle));
  }
  if (token.startsWith("subject:")) {
    const needle = token.slice(8);
    return !needle || message.subject.toLowerCase().includes(needle);
  }
  if (token === "is:unread") return message.unread;
  if (token === "is:starred") return message.starred;
  if (token === "has:file") return Boolean(message.attachments?.length);
  if (token === "is:encrypted") return Boolean(message.extra?.protection || message.extra?.pgp);
  if (token.startsWith("label:")) {
    const needle = token.slice(6);
    return !needle || message.labels.some((label) => label.toLowerCase().includes(needle));
  }
  if (token.startsWith("in:")) {
    const needle = token.slice(3);
    return !needle || message.folder === needle;
  }
  return haystack(message).includes(token);
}

function threadMatches(messages: MailMessage[], row: MailMessage, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const thread = messages.filter((message) => message.threadId === row.threadId);
  return tokens.every((token) => thread.some((message) => tokenMatches(message, token)));
}

export function listThreads(
  messages: MailMessage[],
  box: BoxId,
  query: string,
  unreadOnly: boolean,
  // One clock for the whole list: `inBox` is called many times here, and reading Date.now() in each
  // call lets a snooze that expires mid-list put a message in two boxes at once (or neither).
  now = Date.now(),
): MailMessage[] {
  const inView = messages.filter((m) => inBox(m, box, now));
  const latest = new Map<string, MailMessage>();
  for (const message of inView) {
    const prev = latest.get(message.threadId);
    if (!prev || prev.at < message.at) latest.set(message.threadId, message);
  }
  let rows = [...latest.values()];
  if (query.trim()) rows = rows.filter((row) => threadMatches(messages, row, query));
  if (unreadOnly) {
    rows = rows.filter((row) =>
      messages.some((m) => m.threadId === row.threadId && m.unread && inBox(m, box, now)),
    );
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows;
}

export function threadOf(messages: MailMessage[], threadId: string): MailMessage[] {
  return messages
    .filter((m) => m.threadId === threadId && m.folder !== "drafts")
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function unreadInBox(messages: MailMessage[], box: BoxId): number {
  const threads = new Set(
    messages.filter((m) => inBox(m, box) && m.unread).map((m) => m.threadId),
  );
  return threads.size;
}

export function draftCount(messages: MailMessage[]): number {
  return messages.filter((m) => m.folder === "drafts").length;
}

export function rowTitle(message: MailMessage, meEmail: string = ME.email): string {
  if (message.from.email.toLowerCase() === meEmail.toLowerCase()) {
    const to = message.to[0]?.name || message.to[0]?.email || "someone";
    return `To ${to}`;
  }
  return message.from.name;
}

export type QuotaWarning = "near" | "over" | null;

/**
 * Storage shown in the sidebar. With `usedBytes` from the server it is the real count; without it
 * (sample data, profiles built outside the database) it is the old estimate. Never enforced here:
 * `warning` is a soft notice at 90% and above.
 */
export function quota(
  messages: MailMessage[],
  quotaGb: number = ME.quotaGb,
  usedBytes?: number,
): { label: string; pct: number; warning: QuotaWarning; measured: boolean } {
  const measured = typeof usedBytes === "number" && Number.isFinite(usedBytes) && usedBytes >= 0;
  const bytes = measured
    ? usedBytes
    : 2.41e9 +
      messages.reduce((n, message) => {
        const files = (message.attachments ?? []).reduce((sum, file) => sum + file.size, 0);
        return n + message.subject.length + message.body.length + files;
      }, 0);
  const gb = bytes / 1e9;
  const ratio = quotaGb > 0 ? gb / quotaGb : 1;
  const pct = Math.min(100, ratio * 100);
  const warning: QuotaWarning = ratio >= 1 ? "over" : ratio >= 0.9 ? "near" : null;
  const shown = gb > 0 && gb < 0.01 ? "<0.01" : gb.toFixed(2);
  // "2.41 / 15 GB" reads the same in every language (the catalog translates "GB").
  return { label: `${shown} / ${quotaGb} GB`, pct, warning, measured };
}

export function parsePeople(value: string): Person[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*)<([^>]+)>$/);
      if (match) {
        return { name: match[1].trim().replace(/^"|"$/g, "") || match[2].trim(), email: match[2].trim() };
      }
      if (part.includes("@")) return { name: part.split("@")[0] ?? part, email: part };
      return { name: part, email: part };
    });
}

export function peopleToField(people: Person[]): string {
  return people
    .map((p) => (p.name && p.name !== p.email ? `${p.name} <${p.email}>` : p.email))
    .join(", ");
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function transcript(messages: MailMessage[]): string {
  return messages
    .map(
      (m) =>
        `From: ${m.from.name} <${m.from.email}>\nDate: ${formatWhen(m.at)} UTC\n\n${m.body}`,
    )
    .join("\n\n----\n\n");
}

export function quote(message: MailMessage): string {
  const quoted = message.body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n—\nOn ${formatWhen(message.at)} UTC, ${message.from.name} wrote:\n${quoted}`;
}

export function briefKey(messages: MailMessage[]): string {
  return messages.map((m) => m.id).join(":");
}
