/**
 * Security headers on every response (server/middleware/security-headers.ts). Only headers that cannot
 * break the app: no framing or CSP rules, because the app also runs inside the sandbox preview iframe and
 * loads its own inline bootstrap. A header a route already set is left alone.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** HSTS for a year with subdomains; only sent on https so local http development is unaffected. */
export const HSTS = "max-age=31536000; includeSubDomains";

/** Was the request https, directly or behind a proxy/gateway (`x-forwarded-proto`)? */
export function isHttps(url: string, forwardedProto: string | null | undefined): boolean {
  const proto = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function applySecurityHeaders(headers: Headers, https: boolean): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (https && !headers.has("strict-transport-security")) headers.set("strict-transport-security", HSTS);
  return headers;
}
