/**
 * Free public domain feeds. No paid list, no API key.
 * URLhaus (abuse.ch) publishes a hosts file. The malware-filter mirror is a domain list.
 * `MAIL_SPAM_FEEDS=off` disables the fetch. Unset means these URLs, refreshed hourly.
 */
export const DEFAULT_FEEDS = [
  "https://urlhaus.abuse.ch/downloads/hostfile/",
  "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains.txt",
];

const HOUR = 60 * 60 * 1000;
let cache: { at: number; domains: Set<string> } | null = null;

export function feedsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAIL_SPAM_FEEDS?.trim().toLowerCase() !== "off";
}

export function feedUrls(env: Record<string, string | undefined> = process.env): string[] {
  if (!feedsEnabled(env)) return [];
  const custom = env.MAIL_SPAM_FEEDS?.trim();
  if (custom && custom.toLowerCase() !== "off") {
    return custom.split(",").map((item) => item.trim()).filter((item) => item.startsWith("https://"));
  }
  return DEFAULT_FEEDS;
}

/** Hosts-file and one-domain-per-line text. Comments and addresses are ignored. */
export function parseFeed(body: string): Set<string> {
  const domains = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const token = trimmed.split(/\s+/).pop()?.toLowerCase().replace(/\.$/, "") ?? "";
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(token)) domains.add(token);
  }
  return domains;
}

export async function loadFeeds(
  fetcher: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<Set<string>> {
  if (cache && now - cache.at < HOUR) return cache.domains;
  const domains = new Set<string>();
  for (const url of feedUrls(env)) {
    try {
      const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(2500) });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > 5_000_000) continue;
      for (const domain of parseFeed(text)) domains.add(domain);
    } catch {
      // A feed that is down must not quarantine anyone.
    }
  }
  cache = { at: now, domains };
  return domains;
}

export function resetFeedCache(): void {
  cache = null;
}

export function listedDomain(domains: Set<string>, address: string): boolean {
  const at = address.lastIndexOf("@");
  const domain = (at > 0 ? address.slice(at + 1) : address).trim().toLowerCase();
  if (domains.has(domain)) return true;
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (domains.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
