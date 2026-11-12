/**
 * Smoke check of a DEPLOYED copy: `node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app`.
 * Read-only: it sends GET requests and starts (never completes) one sign-in to read the redirect URL.
 *
 *   1. GET /api/health    -> 200, status ok, the expected region (ru.* -> ru), a commit
 *   2. headers            -> ru.* must not be served through AWS API Gateway (`apigw-requestid`)
 *                            or Cloudflare (`cf-ray`): the Russia copy is on Yandex Cloud
 *   3. GET /              -> 200 and this app, not the old static page worker
 *   4. sign-in            -> the Cumulus ID authorize URL is the region's issuer
 *                            (ru.* -> ru.id.cumuluscloud.app, else id.cumuluscloud.app)
 *
 * Each check returns { name, ok, detail }. `ok: false` fails the run; `warn` is reported only.
 */

const ISSUERS = { us: "id.cumuluscloud.app", ru: "ru.id.cumuluscloud.app" };

export function expectedRegion(hostUrl) {
  return new URL(hostUrl).hostname.toLowerCase().startsWith("ru.") ? "ru" : "us";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function checkHealth(base, fetcher) {
  const region = expectedRegion(base);
  const response = await fetcher(new URL("/api/health", base), { redirect: "manual" });
  const body = await readJson(response);
  if (response.status === 404) {
    return { name: "health", ok: false, detail: "/api/health is 404: the new app is not deployed on this host" };
  }
  if (!body || body.service !== "cumulus-mail") {
    return { name: "health", ok: false, detail: `/api/health answered ${response.status} without a health report` };
  }
  const problems = [];
  if (response.status !== 200 || body.status !== "ok") {
    problems.push(`status ${body.status} (db ${body.db?.ok ? "ok" : body.db?.error ?? "down"}, storage ${body.storage?.ok ? "ok" : body.storage?.error ?? "down"})`);
  }
  if (body.region !== region) problems.push(`region is ${body.region}, expected ${region}`);
  if (!body.commit || body.commit === "unknown") problems.push("no build commit");
  return {
    name: "health",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : `ok, region ${body.region}, commit ${body.commit}, db ${body.db?.source ?? "?"}, storage ${body.storage?.kind ?? "?"}`,
  };
}

export async function checkPage(base, fetcher) {
  const region = expectedRegion(base);
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
  const hsts = response.headers.get("strict-transport-security");
  results.push({ name: "hsts", ok: true, warn: !hsts, detail: hsts ? `HSTS ${hsts}` : "no Strict-Transport-Security header" });
  return results;
}

export async function checkSignIn(base, fetcher) {
  const region = expectedRegion(base);
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

export async function runHostSmoke(base, { fetcher = fetch, log = console.log } = {}) {
  const url = new URL(base);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Use an https:// URL");
  }
  const results = [];
  for (const run of [checkHealth, checkPage, checkSignIn]) {
    try {
      const out = await run(url.toString(), fetcher);
      results.push(...(Array.isArray(out) ? out : [out]));
    } catch (error) {
      results.push({ name: run.name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const r of results) log(`[smoke ${url.hostname}] ${r.ok ? (r.warn ? "WARN" : "ok  ") : "FAIL"} ${r.name}: ${r.detail}`);
  return { ok: results.every((r) => r.ok), results };
}
