import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedRegion, runHostSmoke } from "./host-smoke.mjs";

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
      "GET /": { body: APP, headers: { "cf-ray": "8f-IAD", "strict-transport-security": "max-age=31536000" } },
      "POST /api/auth/sign-in/social": signIn("id.cumuluscloud.app", origin),
    }),
  });
  assert.equal(ok, true, JSON.stringify(results));
});

test("a correct RU deployment passes; the wrong issuer, region or callback fails", async () => {
  const origin = "https://ru.mail.cumuluscloud.app";
  const good = {
    "GET /api/health": health("ru"),
    "GET /": { body: APP },
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
