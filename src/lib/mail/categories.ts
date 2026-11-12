import type { MailMessage } from "./model.ts";

export type Category = "primary" | "updates" | "promotions" | "social";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "primary", label: "Primary" },
  { id: "updates", label: "Updates" },
  { id: "promotions", label: "Promotions" },
  { id: "social", label: "Social" },
];

const SOCIAL_DOMAINS = [
  "facebookmail.com",
  "facebook.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "mastodon.social",
  "discord.com",
  "reddit.com",
  "redditmail.com",
  "pinterest.com",
  "tiktok.com",
  "threads.net",
  "bsky.app",
  "meetup.com",
  "slack.com",
];

/** Headers set by bulk-mail and marketing platforms. */
const PROMO_HEADERS = ["x-campaign", "x-campaign-id", "x-mailchimp-campaign", "x-mc-user", "x-sg-eid", "x-mailgun-tag", "x-marketing", "feedback-id"];
const PROMO_WORDS = /\b(sale|% off|\d+% ?off|discount|deal|deals|offer|coupon|promo|limited time|free shipping|black friday|cyber monday|newsletter)\b/i;
const NOTIFY_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|updates?|info|news|support|billing|receipts?|account|security|mailer-daemon)([+._-].*)?$/i;

function header(message: MailMessage, name: string): string {
  return message.headers?.[name]?.trim() ?? "";
}

function domainOf(email: string): string {
  return email.split("@")[1]?.trim().toLowerCase() ?? "";
}

function inDomains(domain: string, list: string[]): boolean {
  return list.some((item) => domain === item || domain.endsWith(`.${item}`));
}

/**
 * Sort received mail into Primary / Updates / Promotions / Social from its
 * headers and sender. Mail with no list or bulk signals stays Primary, so a
 * person writing directly is never filed away.
 */
export function categorize(message: MailMessage): Category {
  const sender = message.from.email.toLowerCase();
  const domain = domainOf(sender);
  const listId = header(message, "list-id").toLowerCase();
  const unsubscribe = header(message, "list-unsubscribe");
  const precedence = header(message, "precedence").toLowerCase();
  const autoSubmitted = header(message, "auto-submitted").toLowerCase();
  const bulk = precedence === "bulk" || precedence === "list" || precedence === "junk";
  const listed = Boolean(listId || unsubscribe);

  if (inDomains(domain, SOCIAL_DOMAINS) || SOCIAL_DOMAINS.some((item) => listId.includes(item))) return "social";
  if (Object.keys(message.headers ?? {}).some((name) => name.startsWith("x-linkedin") || name.startsWith("x-facebook"))) {
    return "social";
  }
  const promoHeader = PROMO_HEADERS.some((name) => header(message, name));
  if ((listed || bulk) && (promoHeader || PROMO_WORDS.test(message.subject) || precedence === "junk")) return "promotions";
  if (listed || bulk || (autoSubmitted && autoSubmitted !== "no")) return "updates";
  if (NOTIFY_LOCAL.test(sender.split("@")[0] ?? "")) return "updates";
  return "primary";
}

export type Unsubscribe =
  | { kind: "one-click"; url: string }
  | { kind: "mailto"; address: string; subject: string; body: string }
  | { kind: "link"; url: string };

/** Parse List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058). Best option first. */
export function unsubscribeOptions(headers: Record<string, string> | undefined): Unsubscribe[] {
  const raw = headers?.["list-unsubscribe"] ?? "";
  const oneClick = /^\s*List-Unsubscribe=One-Click\s*$/i.test(headers?.["list-unsubscribe-post"] ?? "");
  const options: Unsubscribe[] = [];
  for (const match of raw.matchAll(/<([^>]+)>/g)) {
    const target = (match[1] ?? "").trim();
    if (/^https:\/\//i.test(target)) {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        continue;
      }
      options.push(oneClick ? { kind: "one-click", url: url.href } : { kind: "link", url: url.href });
    } else if (/^mailto:/i.test(target)) {
      const [addressPart, query = ""] = target.slice("mailto:".length).split("?");
      const address = decodeURIComponent(addressPart ?? "").trim();
      if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) continue;
      const params = new URLSearchParams(query);
      options.push({
        kind: "mailto",
        address,
        subject: (params.get("subject") ?? "unsubscribe").replace(/[\r\n]+/g, " ").slice(0, 200),
        body: (params.get("body") ?? "").slice(0, 2000),
      });
    }
  }
  const rank = { "one-click": 0, mailto: 1, link: 2 } as const;
  return options.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export type Subscription = {
  /** List-Id when present, else the sender address. */
  key: string;
  name: string;
  email: string;
  count: number;
  unread: number;
  lastAt: string;
  /** The newest message, which carries the unsubscribe header the server will use. */
  messageId: string;
  option: Unsubscribe | null;
  category: Category;
};

function listKey(message: MailMessage): string {
  const listId = header(message, "list-id");
  const inner = /<([^>]+)>/.exec(listId)?.[1] ?? listId;
  return (inner || message.from.email).trim().toLowerCase();
}

/** Group received list mail by list (or sender), newest first. */
export function subscriptions(messages: MailMessage[], meEmail = ""): Subscription[] {
  const mine = meEmail.toLowerCase();
  const groups = new Map<string, Subscription>();
  for (const message of messages) {
    if (message.folder === "sent" || message.folder === "drafts" || message.folder === "trash") continue;
    if (message.from.email.toLowerCase() === mine) continue;
    if (!header(message, "list-unsubscribe") && !header(message, "list-id")) continue;
    const key = listKey(message);
    const current = groups.get(key);
    const option = unsubscribeOptions(message.headers)[0] ?? null;
    if (!current) {
      groups.set(key, {
        key,
        name: message.from.name || message.from.email,
        email: message.from.email,
        count: 1,
        unread: message.unread ? 1 : 0,
        lastAt: message.at,
        messageId: message.id,
        option,
        category: categorize(message),
      });
      continue;
    }
    current.count += 1;
    if (message.unread) current.unread += 1;
    if (message.at > current.lastAt) {
      Object.assign(current, { lastAt: message.at, messageId: message.id, name: message.from.name || current.name, email: message.from.email });
      if (option) current.option = option;
    } else if (!current.option && option) {
      current.option = option;
    }
  }
  return [...groups.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/**
 * Hosts the server may POST a one-click unsubscribe to: public https names only.
 * Blocks IP literals, localhost, single-label and internal names (SSRF guard).
 */
export function safeUnsubscribeUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return null;
  return url;
}

/** RFC 8058: POST `List-Unsubscribe=One-Click` as a form body, no cookies, no redirects. */
export async function oneClickUnsubscribe(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number }> {
  const safe = safeUnsubscribeUrl(url);
  if (!safe) throw new Error("That unsubscribe address is not allowed.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(safe.href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
