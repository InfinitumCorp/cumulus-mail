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
/** Resolves a host name to its IP addresses. */
export type Resolver = (host: string) => Promise<string[]>;

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function publicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast/reserved
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata (169.254.169.254)
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** True only for globally routable unicast addresses. Anything unparsable counts as not public. */
export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) return publicIpv4(v4);
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (!lower.includes(":")) return false;
  // IPv4-mapped / NAT64 forms carry an IPv4 address at the end: judge that address.
  const tail = /(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (tail) return publicIpv4(ipv4Parts(tail[1]!) ?? [0]);
  if (lower === "::" || lower === "::1") return false;
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return false; // documentation
  return true;
}

/** node:dns lookup, or null where the runtime has no DNS module (Workers block private targets themselves). */
async function systemResolver(host: string): Promise<string[] | null> {
  let dns: typeof import("node:dns/promises");
  try {
    dns = await import("node:dns/promises");
  } catch {
    return null;
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/**
 * Refuse a host whose name resolves to a private, loopback, link-local or otherwise non-public
 * address. The name checks in `safeUnsubscribeUrl` cannot see this: anyone can point a public-looking
 * name at 169.254.169.254 or 10.0.0.1, and the URL comes from an email anyone can send.
 */
export async function assertPublicHost(host: string, resolve: Resolver | null = null): Promise<void> {
  let addresses: string[] | null;
  try {
    addresses = resolve ? await resolve(host) : await systemResolver(host);
  } catch {
    throw new Error("That unsubscribe address does not resolve.");
  }
  if (addresses === null) return;
  if (addresses.length === 0) throw new Error("That unsubscribe address does not resolve.");
  if (!addresses.every(isPublicAddress)) throw new Error("That unsubscribe address points to a private network.");
}

export async function oneClickUnsubscribe(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
  resolve: Resolver | null = null,
): Promise<{ ok: boolean; status: number }> {
  const safe = safeUnsubscribeUrl(url);
  if (!safe) throw new Error("That unsubscribe address is not allowed.");
  await assertPublicHost(safe.hostname, resolve);
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
