/**
 * Smoke check of a DEPLOYED copy: `node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app`.
 * Before cutover, check a copy on its own URL with the region it should be:
 * `--host https://<id>.apigw.yandexcloud.net --region ru` or `--host https://cumulus-mail-api.<acct>.workers.dev`.
 * Read-only: it sends GET requests and starts (never completes) one sign-in to read the redirect URL.
 *
 *   1. GET /api/health    -> 200, status ok, the expected region (ru.* -> ru), a commit
 *   2. headers            -> ru.* must not be served through AWS API Gateway (`apigw-requestid`)
 *                            or Cloudflare (`cf-ray`): the Russia copy is on Yandex Cloud
 *   3. GET /              -> 200 and this app, not the old static page worker
 *   4. sign-in            -> the Cumulus ID authorize URL is the region's issuer
 *                            (ru.* -> ru.id.cumuluscloud.app, else id.cumuluscloud.app)
 *   5. security           -> an enforced CSP with a nonce, the report endpoint and frame-ancestors 'none';
 *                            no grok.com in the CSP or the page; nosniff, referrer and permissions
 *                            policies; HSTS on https
 *   6. api-auth           -> endpoints that need a session, a token or a secret refuse a request without
 *                            one (4xx, never 2xx): a forged export link, the cron tick, a calendar feed
 *                            token, the IMAP bridge
 *   7. mx                 -> with --domain: the domain's MX records are Cloudflare Email Routing (US). The
 *                            inbound worker itself has no HTTP URL (workers_dev is off by design, enforced
 *                            by scripts/deploy-guard.mjs), so mail reaching it is proven by the MX records
 *                            plus a real message (docs/launch/friday.md), not by this script.
 *
 * Each check returns { name, ok, detail }. `ok: false` fails the run; `warn` is reported only.
 */

const ISSUERS = { us: "id.cumuluscloud.app", ru: "ru.id.cumuluscloud.app" };

/** ", schema current" / ", 1 migration pending" / ", schema unreachable"; empty for an older build without the check. */
export function schemaNote(schema) {
  if (!schema) return "";
  if (typeof schema.pending === "number") {
    return schema.pending === 0 ? ", schema current" : `, ${schema.pending} migration${schema.pending === 1 ? "" : "s"} pending`;
  }
  return `, schema ${schema.error ?? "down"}`;
}

/** The region a host should report: `--region` when given (gateway or workers.dev URLs), else ru.* -> ru. */
export function expectedRegion(hostUrl, override) {
  if (override === "ru" || override === "us") return override;
  return new URL(hostUrl).hostname.toLowerCase().startsWith("ru.") ? "ru" : "us";
}

/** ", 41 ms (db 12, storage 20)" from a `?deep=1` report; empty for an older build without timings. */
export function timingNote(timings) {
  if (!timings || typeof timings.total !== "number") return "";
  return `, ${timings.total} ms (db ${timings.db}, storage ${timings.storage}${typeof timings.schema === "number" ? `, schema ${timings.schema}` : ""})`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function checkHealth(base, fetcher, region = expectedRegion(base)) {
  const response = await fetcher(new URL("/api/health?deep=1", base), { redirect: "manual" });
  const body = await readJson(response);
  if (response.status === 404) {
    return { name: "health", ok: false, detail: "/api/health is 404: the new app is not deployed on this host" };
  }
  if (!body || body.service !== "cumulus-mail") {
    return { name: "health", ok: false, detail: `/api/health answered ${response.status} without a health report` };
  }
  const problems = [];
  if (response.status !== 200 || body.status !== "ok") {
    problems.push(`status ${body.status} (db ${body.db?.ok ? "ok" : body.db?.error ?? "down"}, storage ${body.storage?.ok ? "ok" : body.storage?.error ?? "down"}${schemaNote(body.schema)})`);
  }
  if (body.region !== region) problems.push(`region is ${body.region}, expected ${region}`);
  if (!body.commit || body.commit === "unknown") problems.push("no build commit");
  return {
    name: "health",
    ok: problems.length === 0,
    detail: problems.length
      ? problems.join("; ")
      : `ok, region ${body.region}, commit ${body.commit}, db ${body.db?.source ?? "?"}, storage ${body.storage?.kind ?? "?"}${schemaNote(body.schema)}${timingNote(body.timings)}`,
  };
}

export async function checkPage(base, fetcher, region = expectedRegion(base)) {
  const response = await fetcher(new URL("/", base), { redirect: "manual" });
  const html = await response.text().catch(() => "");
  const via = [];
  if (response.headers.get("apigw-requestid")) via.push("AWS API Gateway (apigw-requestid)");
  if (response.headers.get("cf-ray")) via.push("Cloudflare (cf-ray)");
  const results = [];
  if (region === "ru") {
    results.push({
      name: "ru-path",
      ok: via.length === 0,
      detail: via.length ? `ru.* is served through ${via.join(" and ")}, not directly from Yandex Cloud` : "not behind AWS API Gateway or Cloudflare",
    });
  } else if (via.length) {
    results.push({ name: "edge", ok: true, detail: `served through ${via.join(" and ")}` });
  }
  const oldPage = /cumulus-config\.js/.test(html) && !/\/_build\/|tanstack|__TSR/i.test(html);
  results.push({
    name: "page",
    ok: response.status === 200 && !oldPage,
    detail: oldPage
      ? "this is the old static page worker (cumulus-config.js), not the new app"
      : response.status === 200
        ? "200, the app"
        : `answered ${response.status}`,
  });
  return results;
}

const LOCAL = new Set(["localhost", "127.0.0.1"]);

/** The page's security headers and Content-Security-Policy, and no third-party platform script. */
export async function checkSecurity(base, fetcher) {
  const response = await fetcher(new URL("/", base), { redirect: "manual" });
  const html = await response.text().catch(() => "");
  const h = (name) => response.headers.get(name) ?? "";
  const problems = [];
  const warnings = [];
  const csp = h("content-security-policy");
  const reportOnly = h("content-security-policy-report-only");
  if (!csp && reportOnly) warnings.push("CSP is report-only (MAIL_CSP=report-only)");
  const policy = csp || reportOnly;
  if (!policy) problems.push("no Content-Security-Policy");
  else {
    if (!/script-src[^;]*'nonce-/.test(policy)) problems.push("CSP script-src has no nonce");
    if (!/frame-ancestors 'none'/.test(policy)) problems.push("CSP lacks frame-ancestors 'none'");
    if (!/report-uri \/api\/csp-report/.test(policy)) problems.push("CSP does not report to /api/csp-report");
    if (/grok\.com/.test(policy)) problems.push("CSP allows grok.com (VITE_GROK_EXTENSIONS must be off)");
  }
  if (/grok\.com/.test(html)) problems.push("the page loads something from grok.com");
  if (h("x-content-type-options").toLowerCase() !== "nosniff") problems.push("no X-Content-Type-Options: nosniff");
  if (!h("referrer-policy")) problems.push("no Referrer-Policy");
  if (!h("permissions-policy")) problems.push("no Permissions-Policy");
  const url = new URL(base);
  if (!h("strict-transport-security")) {
    if (url.protocol === "https:" && !LOCAL.has(url.hostname)) problems.push("no Strict-Transport-Security");
    else warnings.push("no HSTS (expected on plain http)");
  }
  return {
    name: "security",
    ok: problems.length === 0,
    warn: warnings.length > 0,
    detail: problems.length ? problems.join("; ") : `CSP enforced with a nonce, no grok.com, nosniff, referrer and permissions policies${warnings.length ? `; ${warnings.join("; ")}` : ", HSTS"}`,
  };
}

/** Requests without a session, token or secret: each must be refused (4xx). Read-only: nothing here writes. */
export const AUTH_PROBES = [
  { method: "GET", path: "/api/account/export/not-a-real-token", what: "a forged export link" },
  { method: "POST", path: "/api/cron/tick", what: "the cron tick without its secret" },
  { method: "GET", path: "/api/calendar/not-a-real-token", what: "a calendar feed with a made-up token" },
  { method: "POST", path: "/api/bridge/sync", what: "the IMAP bridge without a token" },
];

export async function checkApiAuth(base, fetcher) {
  const problems = [];
  for (const probe of AUTH_PROBES) {
    const response = await fetcher(new URL(probe.path, base), { method: probe.method, redirect: "manual", headers: { accept: "application/json" } });
    if (response.status < 400 || response.status >= 500) problems.push(`${probe.what} answered ${response.status}`);
  }
  return {
    name: "api-auth",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : `${AUTH_PROBES.length} protected endpoints refuse requests without credentials`,
  };
}

/** MX records of the mail domain. Only with --domain. The US copy receives through Cloudflare Email Routing. */
export async function checkMx(domain, resolveMx, region = "us") {
  let records = [];
  try {
    records = await resolveMx(domain);
  } catch (error) {
    return { name: "mx", ok: false, detail: `no MX for ${domain} (${error?.code ?? "lookup failed"})` };
  }
  if (!records.length) return { name: "mx", ok: false, detail: `no MX for ${domain}` };
  const hosts = records.map((r) => r.exchange).join(", ");
  if (region === "us" && !records.some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r.exchange))) {
    return { name: "mx", ok: false, detail: `MX for ${domain} is ${hosts}, not Cloudflare Email Routing` };
  }
  return { name: "mx", ok: true, detail: `MX ${hosts}` };
}

export async function checkSignIn(base, fetcher, region = expectedRegion(base)) {
  const origin = new URL(base).origin;
  const response = await fetcher(new URL("/api/auth/sign-in/social", base), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ provider: "cumulus-id", callbackURL: "/", disableRedirect: true }),
  });
  const body = await readJson(response);
  const url = typeof body?.url === "string" ? body.url : null;
  if (!url) return { name: "sign-in", ok: false, detail: `no authorize URL (HTTP ${response.status})` };
  const authorize = new URL(url);
  const problems = [];
  if (authorize.hostname !== ISSUERS[region]) problems.push(`issuer is ${authorize.hostname}, expected ${ISSUERS[region]}`);
  if (authorize.searchParams.get("code_challenge_method") !== "S256") problems.push("no PKCE (S256)");
  const callback = authorize.searchParams.get("redirect_uri");
  if (!callback || new URL(callback).origin !== origin) problems.push(`callback ${callback} is not on ${origin}`);
  return {
    name: "sign-in",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : `redirects to ${authorize.hostname} with PKCE, callback on this host`,
  };
}

export async function runHostSmoke(base, { fetcher = fetch, log = console.log, region, domain, resolveMx } = {}) {
  const url = new URL(base);
  if (region !== undefined && region !== "us" && region !== "ru") throw new Error("--region must be us or ru");
  const expected = expectedRegion(url.toString(), region);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Use an https:// URL");
  }
  const results = [];
  const runs = [
    ["health", () => checkHealth(url.toString(), fetcher, expected)],
    ["page", () => checkPage(url.toString(), fetcher, expected)],
    ["sign-in", () => checkSignIn(url.toString(), fetcher, expected)],
    ["security", () => checkSecurity(url.toString(), fetcher)],
    ["api-auth", () => checkApiAuth(url.toString(), fetcher)],
  ];
  if (domain) {
    runs.push([
      "mx",
      async () => checkMx(domain, resolveMx ?? (await import("node:dns")).promises.resolveMx, expected),
    ]);
  }
  for (const [name, run] of runs) {
    try {
      const out = await run();
      results.push(...(Array.isArray(out) ? out : [out]));
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const r of results) log(`[smoke ${url.hostname}] ${r.ok ? (r.warn ? "WARN" : "ok  ") : "FAIL"} ${r.name}: ${r.detail}`);
  return { ok: results.every((r) => r.ok), results };
}
