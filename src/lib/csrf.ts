/**
 * Cross-site request forgery guard for every state-changing request (src/start.ts).
 *
 * The session cookie is SameSite=Lax, which already keeps it off cross-site POSTs. This also covers a
 * *same-site* attacker (another subdomain of the same registrable domain) and a browser that ignores
 * SameSite: a POST, PUT, PATCH or DELETE that the browser says came from another origin is refused.
 *
 * - `Sec-Fetch-Site` (every current browser) must be `same-origin`, or `none` for a user's own action.
 * - Without it, an `Origin` header must match the host the request was sent to.
 * - With neither, it is not a browser request (the Stripe webhook, IMAP bridge, cron), and those
 *   authenticate with signatures or bearer tokens, not cookies. Allowed.
 * - Better Auth's own routes (`/api/auth/*`) check origins themselves, against `trustedOrigins`.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfInput = { method: string; path: string; headers: Headers };

/** Why a request is refused, or null when it may proceed. */
export function csrfRefusal({ method, path, headers }: CsrfInput): string | null {
  if (SAFE.has(method.toUpperCase())) return null;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return null;
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return site === "same-origin" || site === "none" ? null : `sec-fetch-site ${site}`;
  const origin = headers.get("origin")?.trim();
  if (origin) {
    if (origin === "null") return "opaque origin";
    const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "malformed origin";
    }
    return originHost === host ? null : "cross-origin";
  }
  return null;
}
