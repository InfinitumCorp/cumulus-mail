import {
  ME,
  type BoxId,
  type DeliveryHop,
  type MailMessage,
  type Person,
} from "./model.ts";

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

export function planDelivery(people: Person[]): DeliveryHop[] {
  const seen = new Set<string>();
  const hops: DeliveryHop[] = [];
  for (const person of people) {
    const email = person.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    hops.push(
      isCumulus(email)
        ? { email, status: "inside", detail: "Delivered inside Cumulus. End-to-end." }
        : { email, status: "outbound", detail: "Accepted. Leaves Cumulus encrypted." },
    );
  }
  return hops;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function threadMatches(messages: MailMessage[], row: MailMessage, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const thread = messages.filter((message) => message.threadId === row.threadId);
  return thread.some((message) => {
    const free: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("from:")) {
        const needle = token.slice(5);
        if (needle && !`${message.from.name} ${message.from.email}`.toLowerCase().includes(needle)) return false;
      } else if (token.startsWith("to:")) {
        const needle = token.slice(3);
        const people = [...message.to, ...message.cc];
        if (needle && !people.some((person) => `${person.name} ${person.email}`.toLowerCase().includes(needle))) return false;
      } else if (token.startsWith("subject:")) {
        const needle = token.slice(8);
        if (needle && !message.subject.toLowerCase().includes(needle)) return false;
      } else if (token === "is:unread") {
        if (!message.unread) return false;
      } else if (token === "is:starred") {
        if (!message.starred) return false;
      } else if (token === "has:file") {
        if (!message.attachments?.length) return false;
      } else {
        free.push(token);
      }
    }
    return free.every((bit) => haystack(message).includes(bit));
  });
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
  if (query.trim()) rows = rows.filter((row) => threadMatches(messages, row, query));
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
  const extra = messages.reduce((n, message) => {
    const files = (message.attachments ?? []).reduce((sum, file) => sum + file.size, 0);
    return n + message.subject.length + message.body.length + files;
  }, 0);
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
