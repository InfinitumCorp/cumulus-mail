import {
  ME,
  type BoxId,
  type MailMessage,
  type Person,
} from "./model";

const CUMULUS = "@cumulusmail.cloud";

export function isCumulus(email: string): boolean {
  return email.toLowerCase().endsWith(CUMULUS);
}

export function isE2E(message: MailMessage): boolean {
  const people = [message.from, ...message.to, ...message.cc];
  return people.length > 0 && people.every((p) => isCumulus(p.email));
}

export function inBox(message: MailMessage, box: BoxId): boolean {
  if (box === "starred") return message.starred && message.folder !== "trash";
  return message.folder === box;
}

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function formatShort(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "•";
}

export function listThreads(
  messages: MailMessage[],
  box: BoxId,
  query: string,
  unreadOnly: boolean,
): MailMessage[] {
  const inView = messages.filter((m) => inBox(m, box));
  const latest = new Map<string, MailMessage>();
  for (const message of inView) {
    const prev = latest.get(message.threadId);
    if (!prev || prev.at < message.at) latest.set(message.threadId, message);
  }
  let rows = [...latest.values()];
  const q = query.trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) =>
      messages
        .filter((m) => m.threadId === row.threadId)
        .some((m) =>
          [m.subject, m.body, m.from.name, m.from.email, ...m.to.flatMap((p) => [p.name, p.email]), ...m.labels]
            .join("\n")
            .toLowerCase()
            .includes(q),
        ),
    );
  }
  if (unreadOnly) {
    rows = rows.filter((row) =>
      messages.some((m) => m.threadId === row.threadId && m.unread && inBox(m, box)),
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

export function rowTitle(message: MailMessage): string {
  if (message.from.email === ME.email) {
    const to = message.to[0]?.name || message.to[0]?.email || "someone";
    return `To ${to}`;
  }
  return message.from.name;
}

export function quota(messages: MailMessage[]): { label: string; pct: number } {
  const extra = messages.reduce((n, m) => n + m.subject.length + m.body.length, 0);
  const bytes = 2.41e9 + extra;
  const gb = bytes / 1e9;
  const pct = Math.min(100, (gb / ME.quotaGb) * 100);
  return { label: `${gb.toFixed(2)} GB of ${ME.quotaGb} GB`, pct };
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
