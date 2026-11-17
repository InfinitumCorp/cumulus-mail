import assert from "node:assert/strict";
import { test } from "node:test";
import { checkApiAuth, checkMx, checkSecurity, expectedRegion, runHostSmoke, schemaNote, timingNote } from "./host-smoke.mjs";

/** A fake host: routes -> { status, headers, body }. */
function host(routes) {
  return async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    const route = routes[key] ?? { status: 404, body: "Not found" };
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
}

const health = (region) => ({
  body: { status: "ok", service: "cumulus-mail", commit: "6806a79a8e17", region, db: { ok: true, source: "postgres" }, storage: { ok: true, kind: "s3" } },
});
const signIn = (issuer, origin) => ({
  body: {
    url: `https://${issuer}/api/id/authorize?response_type=code&code_challenge_method=S256&redirect_uri=${encodeURIComponent(`${origin}/api/auth/callback/cumulus-id`)}`,
  },
});
const APP = '<html><script type="module" src="/_build/assets/main.js"></script><title>Cumulus://Mail</title></html>';
const quiet = () => {};
/** The headers a correct deploy sends on its pages (src/lib/security-headers.ts, src/lib/csp.ts). */
const SECURE = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri /api/csp-report; report-to csp",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=()",
  "strict-transport-security": "max-age=31536000",
};

test("the region is read from the host", () => {
  assert.equal(expectedRegion("https://mail.cumuluscloud.app"), "us");
  assert.equal(expectedRegion("https://ru.mail.cumuluscloud.app"), "ru");
});

test("today's production fails clearly: old page worker, no /api/health, ru through AWS and Cloudflare", async () => {
  const oldPage = '<html><script src="/cumulus-config.js"></script><h1>cumulus-mail</h1></html>';
  const { ok, results } = await runHostSmoke("https://ru.mail.cumuluscloud.app", {
    log: quiet,
    fetcher: host({
      "GET /": { body: oldPage, headers: { "apigw-requestid": "abc=", "cf-ray": "8f-AMS" } },
    }),
  });
  assert.equal(ok, false);
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.match(byName.health.detail, /404: the new app is not deployed/);
  assert.match(byName["ru-path"].detail, /AWS API Gateway \(apigw-requestid\) and Cloudflare \(cf-ray\)/);
  assert.match(byName.page.detail, /old static page worker/);
  assert.equal(byName["sign-in"].ok, false);
});

test("a correct US deployment passes, Cloudflare in front is fine there", async () => {
  const origin = "https://mail.cumuluscloud.app";
  const { ok, results } = await runHostSmoke(origin, {
    log: quiet,
    fetcher: host({
      "GET /api/health": health("us"),
      "GET /": { body: APP, headers: { ...SECURE, "cf-ray": "8f-IAD" } },
      "POST /api/auth/sign-in/social": signIn("id.cumuluscloud.app", origin),
    }),
  });
  assert.equal(ok, true, JSON.stringify(results));
});

test("a correct RU deployment passes; the wrong issuer, region or callback fails", async () => {
  const origin = "https://ru.mail.cumuluscloud.app";
  const good = {
    "GET /api/health": health("ru"),
    "GET /": { body: APP, headers: SECURE },
    "POST /api/auth/sign-in/social": signIn("ru.id.cumuluscloud.app", origin),
  };
  assert.equal((await runHostSmoke(origin, { log: quiet, fetcher: host(good) })).ok, true);

  const wrongIssuer = await runHostSmoke(origin, {
    log: quiet,
    fetcher: host({ ...good, "POST /api/auth/sign-in/social": signIn("id.cumuluscloud.app", origin) }),
  });
  assert.match(wrongIssuer.results.find((r) => r.name === "sign-in").detail, /expected ru\.id\.cumuluscloud\.app/);

  const wrongRegion = await runHostSmoke(origin, { log: quiet, fetcher: host({ ...good, "GET /api/health": health("us") }) });
  assert.match(wrongRegion.results.find((r) => r.name === "health").detail, /region is us, expected ru/);

  const wrongCallback = await runHostSmoke(origin, {
    log: quiet,
    fetcher: host({ ...good, "POST /api/auth/sign-in/social": signIn("ru.id.cumuluscloud.app", "https://mail.cumuluscloud.app") }),
  });
  assert.match(wrongCallback.results.find((r) => r.name === "sign-in").detail, /is not on https:\/\/ru\.mail/);
});

test("plain http to a public host is refused", async () => {
  await assert.rejects(() => runHostSmoke("http://mail.cumuluscloud.app", { log: quiet }), /https/);
});

test("schemaNote: current, pending count, unreachable, absent", () => {
  assert.equal(schemaNote(undefined), "");
  assert.equal(schemaNote({ ok: true, ms: 3, pending: 0 }), ", schema current");
  assert.equal(schemaNote({ ok: false, ms: 3, pending: 1 }), ", 1 migration pending");
  assert.equal(schemaNote({ ok: false, ms: 3, pending: 2 }), ", 2 migrations pending");
  assert.equal(schemaNote({ ok: false, ms: 3000, error: "timeout" }), ", schema timeout");
});

test("--region checks a copy on its own URL before cutover (gateway or workers.dev domain)", async () => {
  const origin = "https://d5d1abc.apigw.yandexcloud.net";
  const fetcher = host({
    "GET /api/health": health("ru"),
    "GET /": { body: APP, headers: SECURE },
    "POST /api/auth/sign-in/social": signIn("ru.id.cumuluscloud.app", origin),
  });
  assert.equal((await runHostSmoke(origin, { log: quiet, fetcher })).ok, false);
  const ru = await runHostSmoke(origin, { log: quiet, fetcher, region: "ru" });
  assert.equal(ru.ok, true, JSON.stringify(ru.results));
  assert.ok(ru.results.some((r) => r.name === "ru-path"));
  await assert.rejects(() => runHostSmoke(origin, { log: quiet, fetcher, region: "eu" }), /--region/);
});

test("security: a missing header, a report-only CSP, grok.com anywhere, or no HSTS on https are caught", async () => {
  const base = "https://mail.cumuluscloud.app";
  const at = (headers, body = APP) => checkSecurity(base, host({ "GET /": { body, headers } }));
  assert.equal((await at(SECURE)).ok, true);
  const grok = await at({ ...SECURE, "content-security-policy": `${SECURE["content-security-policy"]}; script-src-elem https://grok.com/x.js` });
  assert.equal(grok.ok, false);
  assert.match(grok.detail, /grok\.com/);
  assert.match((await at(SECURE, `${APP}<script src="https://grok.com/grok-app-builder/extensions.js"></script>`)).detail, /loads something from grok\.com/);
  const { "x-content-type-options": _n, "strict-transport-security": _h, ...bare } = SECURE;
  const missing = await at(bare);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /nosniff/);
  assert.match(missing.detail, /Strict-Transport-Security/);
  const { "content-security-policy": policy, ...rest } = SECURE;
  const reportOnly = await at({ ...rest, "content-security-policy-report-only": policy });
  assert.equal(reportOnly.ok, true);
  assert.equal(reportOnly.warn, true, "report-only is reported, not failed");
  const noNonce = await at({ ...SECURE, "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'" });
  assert.match(noNonce.detail, /no nonce/);
  // On plain http to localhost, missing HSTS is only a warning.
  const local = await checkSecurity("http://127.0.0.1:3000", host({ "GET /": { body: APP, headers: bare } }));
  assert.doesNotMatch(local.detail, /Strict-Transport-Security/);
});

test("api-auth: every protected endpoint must refuse an anonymous request; a 2xx or a 5xx fails", async () => {
  const base = "https://mail.cumuluscloud.app";
  assert.equal((await checkApiAuth(base, host({}))).ok, true, "404s and 401s are refusals");
  const open = await checkApiAuth(base, host({ "POST /api/cron/tick": { status: 200, body: { released: 0 } } }));
  assert.equal(open.ok, false);
  assert.match(open.detail, /cron tick without its secret answered 200/);
  const broken = await checkApiAuth(base, host({ "GET /api/account/export/not-a-real-token": { status: 500, body: "boom" } }));
  assert.match(broken.detail, /forged export link answered 500/);
});

test("mx: Cloudflare Email Routing for the US copy; none, or another provider, fails", async () => {
  const cf = async () => [{ exchange: "route1.mx.cloudflare.net", priority: 10 }];
  assert.equal((await checkMx("cumuluscloud.app", cf)).ok, true);
  assert.equal((await checkMx("cumuluscloud.app", async () => [{ exchange: "mx.other.example", priority: 10 }])).ok, false);
  assert.equal((await checkMx("cumuluscloud.app", async () => [])).ok, false);
  const nx = await checkMx("cumuluscloud.app", async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })));
  assert.match(nx.detail, /ENOTFOUND/);
  assert.equal((await checkMx("cumuluscloud.app", async () => [{ exchange: "mx.yandex.net", priority: 10 }], "ru")).ok, true);
});

test("--domain adds the MX check to a run; health shows the deep timings", async () => {
  const origin = "https://mail.cumuluscloud.app";
  const deep = { body: { ...health("us").body, timings: { db: 12, storage: 20, schema: 4, total: 41 } } };
  const { ok, results } = await runHostSmoke(origin, {
    log: quiet,
    domain: "cumuluscloud.app",
    resolveMx: async () => [{ exchange: "route1.mx.cloudflare.net", priority: 10 }],
    fetcher: host({
      "GET /api/health": deep,
      "GET /": { body: APP, headers: SECURE },
      "POST /api/auth/sign-in/social": signIn("id.cumuluscloud.app", origin),
    }),
  });
  assert.equal(ok, true, JSON.stringify(results));
  assert.match(results.find((r) => r.name === "health").detail, /41 ms \(db 12, storage 20, schema 4\)/);
  assert.ok(results.some((r) => r.name === "mx" && r.ok));
  assert.equal(timingNote(undefined), "");
});
