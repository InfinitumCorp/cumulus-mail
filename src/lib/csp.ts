/**
 * Content-Security-Policy for both copies (src/start.ts sets it on every HTML response).
 *
 * Strict and nonce-based: scripts run only from this origin or with this response's nonce, which
 * TanStack Router puts on its own inline bootstrap (router `ssr.nonce`, read back on the client from
 * `<meta property="csp-nonce">`). No third-party origin is allowed, with one explicit exception: while
 * the platform extensions script is on (VITE_GROK_EXTENSIONS, never on the Russia copy, see
 * scripts/grok-pwa-shared.mjs), its single script URL is allowed, and nothing else on that host.
 *
 * `MAIL_CSP` stages it:
 *   enforce      Content-Security-Policy (the default for a production build)
 *   report-only  Content-Security-Policy-Report-Only: violations are reported in the console, nothing
 *                is blocked. For checking a copy before turning enforcement on.
 *   off          no CSP header
 * The development server never gets one (Vite injects its own inline scripts).
 *
 * Pure: no environment or request access here, so every rule is testable.
 */
export type CspMode = "enforce" | "report-only" | "off";

export const GROK_EXTENSIONS_URL = "https://grok.com/grok-app-builder/extensions.js";

export function cspMode(env: Record<string, string | undefined>, production: boolean): CspMode {
  const value = env.MAIL_CSP?.trim().toLowerCase();
  if (value === "enforce" || value === "report-only" || value === "off") return value;
  return production ? "enforce" : "off";
}

export function cspHeaderName(mode: Exclude<CspMode, "off">): string {
  return mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only";
}

/** 128 random bits, base64. A fresh one per response. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

export function buildCsp(options: { nonce: string; extensionsScript?: boolean }): string {
  const script = ["'self'", `'nonce-${options.nonce}'`, ...(options.extensionsScript ? [GROK_EXTENSIONS_URL] : [])];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", `'nonce-${options.nonce}'`]],
    // React `style={{…}}` attributes. Attribute styles cannot run script; elements and sheets stay strict.
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'"]],
    ["media-src", ["'self'", "blob:"]],
    ["frame-src", ["'self'", "blob:"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
