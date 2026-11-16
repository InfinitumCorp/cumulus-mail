import { applySecurityHeaders, isHttps } from "../../src/lib/security-headers.ts";

/**
 * Adds src/lib/security-headers.ts headers to every response this server produces (pages, API, assets
 * served by the app). Auto-registered like the other middleware here (`serverDir: "./server"`).
 */
type SecurityEvent = {
  url: URL;
  req: { headers: Headers };
  res?: { headers?: Headers };
};

export default async function securityHeaders(
  event: SecurityEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const https = isHttps(event.url.toString(), event.req.headers.get("x-forwarded-proto"));
  if (event.res?.headers) applySecurityHeaders(event.res.headers, https);
  const result = await next();
  if (result instanceof Response) {
    const headers = applySecurityHeaders(new Headers(result.headers), https);
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
  }
  return result;
}
