import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

/**
 * One nonce per request, for the Content-Security-Policy (src/lib/csp.ts). The router puts it on its
 * inline scripts (src/router.tsx reads it from the start context), and the header is set here on the
 * HTML response it belongs to. Other responses (API, assets) get no CSP: they run no script.
 */
const cspMiddleware = createMiddleware().server(async ({ next, request }) => {
  const { buildCsp, cspHeaderName, cspMode, newNonce } = await import("./lib/csp");
  const nonce = newNonce();
  const result = await next({ context: { nonce } });
  const mode = cspMode(process.env, import.meta.env.PROD);
  const type = result.response.headers.get("content-type") ?? "";
  if (mode !== "off" && type.includes("text/html")) {
    const { readGrokExtensionsEnabled } = await import("../scripts/grok-pwa-shared.mjs");
    const { regionFor } = await import("./lib/region");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
    // The platform extensions script is allowed by its exact URL only while it is on, and never on the
    // Russia copy (the head injector leaves it out there, #116; until then the CSP blocks it).
    const extensionsScript = readGrokExtensionsEnabled() && regionFor(host) !== "ru";
    result.response.headers.set(cspHeaderName(mode), buildCsp({ nonce, extensionsScript }));
  }
  return result;
});

/**
 * Refuse a state-changing request that the browser says came from another site (src/lib/csrf.ts).
 * Covers server functions and API routes alike; Better Auth checks its own routes.
 */
const csrfMiddleware = createMiddleware().server(async ({ next, request }) => {
  const { csrfRefusal } = await import("./lib/csrf");
  const refusal = csrfRefusal({ method: request.method, path: new URL(request.url).pathname, headers: request.headers });
  if (refusal) {
    return new Response("Forbidden: cross-site request", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-csrf-refused": refusal },
    });
  }
  return next();
});

/**
 * Server functions are same-origin RPC. TanStack Start protects them with this middleware by default,
 * but only while the app has no start instance: once `createStart` exists (for the CSP above), the
 * default is dropped and it has to be listed here. A browser request from another site is refused
 * with 403 before any server function runs. Requests with no Sec-Fetch-Site, Origin or Referer (not a
 * browser, so no ambient cookies) are allowed, as `assertSameSiteRequest` (auth/isolation.server.ts)
 * already allows them for authenticated calls.
 */
export const serverFnCsrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  allowRequestsWithoutOriginCheck: true,
});

export const startInstance = createStart(() => ({ requestMiddleware: [serverFnCsrfMiddleware, csrfMiddleware, cspMiddleware] }));
