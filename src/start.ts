import { createMiddleware, createStart } from "@tanstack/react-start";

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

export const startInstance = createStart(() => ({ requestMiddleware: [cspMiddleware] }));
