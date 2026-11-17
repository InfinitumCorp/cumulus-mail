/**
 * Maintenance mode for a launch or migration window: `MAIL_MAINTENANCE=1` (or `on`) makes every page and
 * API answer 503 with a static page in English and Russian. Dependency-free; read per request, so
 * setting or clearing the variable takes effect on the next request after a redeploy or restart.
 *
 * Still served during maintenance, so monitoring and the scheduler keep working:
 *   /api/health        (the smoke check and uptime monitors)
 *   /api/csp-report    (browsers' violation reports)
 *   /api/cron/tick     (the Russia copy's scheduler; it is authenticated by CRON_SECRET)
 * Static files (scripts, styles, icons, the offline page) are served before this runs.
 */
export function maintenanceOn(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.MAIL_MAINTENANCE?.trim().toLowerCase();
  return value === "1" || value === "on" || value === "true";
}

const PASS_THROUGH = new Set(["/api/health", "/api/csp-report", "/api/cron/tick"]);

export function maintenanceAllows(pathname: string): boolean {
  return PASS_THROUGH.has(pathname.replace(/\/+$/, "") || "/");
}

/** How long clients are told to wait before retrying, in seconds. */
export const RETRY_AFTER_SECONDS = 600;

// A static page served before the app (no interface runtime), so both languages are written here.
// [language, heading, text, retry]
type Words = readonly [string, string, string, string];
const EN: Words = [
  "en",
  "Cumulus://Mail is being updated",
  "We're making Cumulus://Mail better and will be back in a few minutes. Your mail is safe, and mail sent to you is still being received.",
  "Try again",
];
const RU: Words = [
  "ru",
  "Cumulus://Mail обновляется",
  "Мы улучшаем Cumulus://Mail и вернёмся через несколько минут. Ваша почта в сохранности, а новые письма продолжают приходить.",
  "Повторить",
];

/** The page, Russian first on the Russia copy. No script; inline styles only (its own CSP allows them). */
export function maintenanceHtml(region: "us" | "ru" = "us"): string {
  const [first, second] = region === "ru" ? [RU, EN] : [EN, RU];
  const block = ([lang, heading, text]: Words, tag: "h1" | "h2") =>
    `<div lang="${lang}"><${tag} style="font-size:${tag === "h1" ? "1.5rem" : "1.25rem"};font-weight:500;margin:${tag === "h1" ? "1.5rem" : "2rem"} 0 .5rem">${heading}</${tag}><p style="color:#4a5560;line-height:1.5;margin:0">${text}</p></div>`;
  return `<!doctype html>
<html lang="${first[0]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${first[1]}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
</head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#111820">
<main style="max-width:28rem;margin:0 auto;padding:3rem 1.25rem">
<img src="/icons/icon-192.png" width="56" height="56" alt="" style="display:block">
${block(first, "h1")}
${block(second, "h2")}
<p style="margin:2rem 0 0"><a href="/" style="display:inline-flex;align-items:center;min-height:44px;padding:0 1rem;background:#111820;color:#fff;text-decoration:none">${first[3]} · <span lang="${second[0]}">${second[3]}</span></a></p>
</main>
</body>
</html>`;
}

/** The 503 for a request during maintenance: the page for browsers, a short JSON for API and RPC calls. */
export function maintenanceResponse(request: Request, region: "us" | "ru"): Response {
  const headers = {
    "retry-after": String(RETRY_AFTER_SECONDS),
    "cache-control": "no-store",
    "x-maintenance": "1",
  };
  const path = new URL(request.url).pathname;
  const wantsHtml = request.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/_serverFn") && (request.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    return Response.json({ error: "maintenance", retryAfter: RETRY_AFTER_SECONDS }, { status: 503, headers });
  }
  return new Response(maintenanceHtml(region), {
    status: 503,
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      // Static and script-free: nothing but its own inline styles and same-origin images.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
