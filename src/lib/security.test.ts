/**
 * The security pass on auth, sessions and the public endpoints: one test per finding.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { authRateLimit, deployedTrustedOrigins } from "./auth/auth-settings.ts";
import { csrfRefusal } from "./csrf.ts";
import { ACTION_LIMITS, RateLimitedError, resetActionLimits, takeAction } from "./rate-limit.ts";

const root = join(import.meta.dirname, "..", "..");
const headers = (h: Record<string, string>) => new Headers(h);

// --- CSRF ----------------------------------------------------------------------------------------

test("CSRF: a state-changing request the browser marks cross-site or same-site is refused", () => {
  const post = (h: Record<string, string>, path = "/_serverFn/abc") => csrfRefusal({ method: "POST", path, headers: headers(h) });
  assert.equal(post({ "sec-fetch-site": "same-origin" }), null);
  assert.equal(post({ "sec-fetch-site": "none" }), null, "the user's own navigation");
  assert.match(post({ "sec-fetch-site": "cross-site" }) ?? "", /cross-site/);
  assert.match(post({ "sec-fetch-site": "same-site" }) ?? "", /same-site/, "a sibling subdomain is another origin");
  // No Sec-Fetch-Site (older browsers): Origin must be this host.
  assert.equal(post({ origin: "https://mail.cumuluscloud.app", host: "mail.cumuluscloud.app" }), null);
  assert.equal(post({ origin: "https://mail.cumuluscloud.app", host: "internal:8080", "x-forwarded-host": "mail.cumuluscloud.app" }), null);
  assert.equal(post({ origin: "https://evil.example", host: "mail.cumuluscloud.app" }), "cross-origin");
  assert.equal(post({ origin: "null", host: "mail.cumuluscloud.app" }), "opaque origin", "sandboxed or file:// pages");
  // Not a browser (Stripe webhook, IMAP bridge, cron): authenticated by signature or bearer token.
  assert.equal(post({}, "/api/billing/webhook"), null);
});

test("CSRF: reads are never refused, and Better Auth's own routes keep their own origin check", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(csrfRefusal({ method, path: "/", headers: headers({ "sec-fetch-site": "cross-site" }) }), null);
  }
  assert.equal(csrfRefusal({ method: "POST", path: "/api/auth/sign-out", headers: headers({ "sec-fetch-site": "cross-site" }) }), null);
});

test("CSRF: the middleware is installed ahead of every request handler", () => {
  const start = readFileSync(join(root, "src/start.ts"), "utf8");
  assert.match(start, /requestMiddleware: \[csrfMiddleware, cspMiddleware\]/);
});

// --- rate limits ---------------------------------------------------------------------------------

beforeEach(() => resetActionLimits());

test("rate limits: export, import, share, domain check, abuse report and unsubscribe are limited per mailbox", () => {
  const [limit, seconds] = ACTION_LIMITS.export;
  for (let i = 0; i < limit; i += 1) takeAction("tenant-a", "export", 0);
  assert.throws(() => takeAction("tenant-a", "export", 1000), (e: unknown) => e instanceof RateLimitedError && e.retryAfterSeconds > 0);
  takeAction("tenant-b", "export", 1000); // another mailbox is unaffected
  takeAction("tenant-a", "import", 1000); // and so is another action
  takeAction("tenant-a", "export", seconds * 1000 + 1); // a new window
});

test("rate limits: every limited action is applied in the session functions that do it", () => {
  const source = readFileSync(join(root, "src/lib/mail/mailbox.server.ts"), "utf8");
  for (const [fn, action] of [
    ["exportMailboxForSession", "export"],
    ["importMailboxForSession", "import"],
    ["issueShareForSession", "share"],
    ["checkDomainForSession", "domainCheck"],
    ["submitAbuseForSession", "abuseReport"],
    ["unsubscribeForSession", "unsubscribe"],
  ]) {
    const body = source.slice(source.indexOf(`export async function ${fn}(`)).split("\nexport ")[0]!;
    assert.match(body, new RegExp(`takeAction\\(tenantId, "${action}"\\)`), fn);
  }
});

test("rate limits: sign-in is limited on a deployed copy even without NODE_ENV (Workers)", () => {
  const deployed = authRateLimit({ BETTER_AUTH_URL: "https://mail.cumuluscloud.app" });
  assert.equal(deployed.enabled, true);
  assert.deepEqual(deployed.customRules["/sign-in/*"], { window: 60, max: 10 });
  assert.equal(authRateLimit({ NODE_ENV: "production" }).enabled, true);
  assert.equal(authRateLimit({}).enabled, false, "local development and tests are not limited");
});

// --- open redirect -------------------------------------------------------------------------------

test("open redirect: a deployed copy trusts only its own origin, not the local development ones", () => {
  const local = ["http://localhost:8080", "http://127.0.0.1:8080"];
  assert.deepEqual(deployedTrustedOrigins("https://mail.cumuluscloud.app/", local), ["https://mail.cumuluscloud.app"]);
  assert.deepEqual(deployedTrustedOrigins("http://localhost:8080", local), ["http://localhost:8080", ...local]);
});

test("open redirect: sign-in refuses a callbackURL off this origin; same-origin paths work", async () => {
  const auth = betterAuth({
    baseURL: "https://mail.cumuluscloud.app",
    secret: "x".repeat(40),
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    trustedOrigins: deployedTrustedOrigins("https://mail.cumuluscloud.app", ["http://localhost:8080"]),
    socialProviders: { github: { clientId: "id", clientSecret: "secret" } },
  });
  const start = (callbackURL: string) =>
    auth.handler(
      new Request("https://mail.cumuluscloud.app/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://mail.cumuluscloud.app" },
        body: JSON.stringify({ provider: "github", callbackURL, disableRedirect: true }),
      }),
    );
  assert.equal((await start("/")).status, 200);
  assert.equal((await start("https://mail.cumuluscloud.app/inbox")).status, 200);
  for (const evil of ["https://evil.example/", "//evil.example/x", "http://localhost:8080/", "https://mail.cumuluscloud.app.evil.example/"]) {
    assert.equal((await start(evil)).status, 403, evil);
  }
});

// --- tenant isolation ----------------------------------------------------------------------------

test("isolation: every authenticated server function passes the session's user, never one from the request", () => {
  const api = readFileSync(join(root, "src/lib/mail/api.ts"), "utf8");
  const fns = api.split("export const ").slice(1);
  const authed = fns.filter((f) => f.includes(".middleware([authMiddleware])"));
  assert.ok(authed.length >= 10, "found the authenticated server functions");
  for (const fn of authed) {
    const name = fn.slice(0, fn.indexOf(" "));
    const calls = [...fn.matchAll(/(\w+ForSession)\(([^,)]*)/g)];
    assert.ok(calls.length > 0, `${name} goes through a *ForSession function`);
    for (const [, callee, first] of calls) assert.equal(first.trim(), "context.userId", `${name} -> ${callee}`);
    assert.doesNotMatch(fn, /data\.(userId|tenantId|tenant)\b/, `${name} never takes a user or tenant from the request`);
  }
});

test("isolation: every *ForSession function resolves the mailbox from the session before touching data", () => {
  const source = readFileSync(join(root, "src/lib/mail/mailbox.server.ts"), "utf8");
  const fns = [...source.matchAll(/export async function (\w+ForSession)\(([^)]*)\)/g)];
  assert.ok(fns.length >= 10);
  for (const [, name, params] of fns) {
    assert.doesNotMatch(params, /tenant/i, `${name} takes no tenant parameter`);
    const body = source.slice(source.indexOf(`export async function ${name}(`)).split("\nexport ")[0]!;
    const resolve = body.indexOf("sessionMailbox(contextUserId, bearerToken)");
    assert.ok(resolve > 0, `${name} resolves the session`);
    for (const use of ["database()", "storageFor(", "db.query("]) {
      const at = body.indexOf(use);
      if (at >= 0) assert.ok(at > resolve, `${name}: ${use} only after the session is resolved`);
    }
  }
  // And the resolver refuses a context user that is not the session's.
  assert.match(source, /if \(session\.id !== contextUserId\) throw new TenantAccessError/);
});
