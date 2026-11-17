/**
 * Which hosts search engines may index. Before cutover each copy runs on a platform URL
 * (`*.workers.dev`, `*.apigw.yandexcloud.net`, `*.containers.yandexcloud.net`, a Vercel preview, localhost);
 * none of those should end up in search results next to, or instead of, the real names. Every response
 * from a host that is not a production name gets `X-Robots-Tag: noindex, nofollow`.
 *
 * Production names: `mail.cumuluscloud.app` and `ru.mail.cumuluscloud.app`, or the comma list in
 * `INDEXABLE_HOSTS` when set (plain host names; anything else in the list is ignored).
 *
 * Static files (served before the app middleware, or by the Workers assets binding) carry no header;
 * search engines index pages, which do.
 */
export const DEFAULT_INDEXABLE_HOSTS = ["mail.cumuluscloud.app", "ru.mail.cumuluscloud.app"] as const;

export const NOINDEX = "noindex, nofollow";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function indexableHosts(raw: string | undefined): string[] {
  const configured = (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => HOST.test(host));
  return configured.length ? configured : [...DEFAULT_INDEXABLE_HOSTS];
}

/** The bare host name of a Host header or URL host (port and trailing dot removed, lower-cased). */
export function hostName(host: string | null | undefined): string {
  const value = (host ?? "").trim().toLowerCase();
  const bare = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
  return bare.replace(/\.$/, "");
}

export function isIndexableHost(host: string | null | undefined, raw = process.env.INDEXABLE_HOSTS): boolean {
  return indexableHosts(raw).includes(hostName(host));
}

/**
 * Paths that stay out of search on every host, production included: `/p/<token>` is a password-protected
 * message somebody was sent (the URL is the capability; a search result would hand it to strangers), and
 * the API and server-function endpoints are not pages.
 */
const PRIVATE_PATHS = ["/p/", "/api/", "/_serverFn/"];

export function isPrivatePath(path: string | null | undefined): boolean {
  const value = path ?? "";
  return PRIVATE_PATHS.some((prefix) => value.startsWith(prefix));
}

/**
 * Adds `X-Robots-Tag` for a non-production host, or for a private path on any host, unless the response
 * already set one.
 */
export function applyIndexing(
  headers: Headers,
  host: string | null | undefined,
  raw = process.env.INDEXABLE_HOSTS,
  path = "",
): Headers {
  if ((!isIndexableHost(host, raw) || isPrivatePath(path)) && !headers.has("x-robots-tag")) {
    headers.set("x-robots-tag", NOINDEX);
  }
  return headers;
}
