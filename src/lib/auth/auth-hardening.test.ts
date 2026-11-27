/**
 * Session hardening, on a real Better Auth instance with the app's own cookie and session settings
 * (AUTH_COOKIES, AUTH_SESSION, authRateLimit). Email/password is switched on here only to mint sessions
 * without an identity provider; the app itself signs in with Cumulus ID.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { AUTH_COOKIES, AUTH_SESSION, SESSION_TOKEN_COOKIE, authRateLimit } from "./auth-settings.ts";

const BASE = "https://ru.mail.cumuluscloud.app";

function instance(env: Record<string, string | undefined> = {}) {
  return betterAuth({
    baseURL: BASE,
    secret: "s".repeat(48),
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    session: AUTH_SESSION,
    rateLimit: authRateLimit(env),
    advanced: { ...AUTH_COOKIES, ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  });
}

type Auth = ReturnType<typeof instance>;

/** name=value pairs of every Set-Cookie, and the raw headers. */
function cookiesOf(response: Response): { jar: Map<string, string>; raw: string[] } {
  const raw = response.headers.getSetCookie();
  const jar = new Map<string, string>();
  for (const line of raw) {
    const [pair] = line.split(";");
    const at = pair!.indexOf("=");
    jar.set(pair!.slice(0, at), pair!.slice(at + 1));
  }
  return { jar, raw };
}

const cookieHeader = (jar: Map<string, string>) => [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");

function post(auth: Auth, path: string, body: unknown, cookie = "", ip = "198.51.100.7") {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

/** The session as the SERVER checks it for mail (verify.server.ts): never from the cookie cache. */
async function serverSession(auth: Auth, cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
}

async function signUp(auth: Auth, email: string, cookie = "") {
  const response = await post(auth, "/sign-up/email", { email, password: "correct horse battery", name: "Ada" }, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  return cookiesOf(response);
}

async function signIn(auth: Auth, email: string, cookie = "") {
  const response = await post(auth, "/sign-in/email", { email, password: "correct horse battery" }, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  return cookiesOf(response);
}

test("session cookies are __Host-: Secure, HttpOnly, SameSite=Lax, Path=/ and never a Domain (mail. and ru.mail. stay apart)", async () => {
  const auth = instance();
  const { raw, jar } = await signUp(auth, "cookies@example.com");
  assert.ok(jar.get(SESSION_TOKEN_COOKIE), "the session cookie is set");
  for (const line of raw) {
    const name = line.split("=")[0]!;
    assert.ok(name.startsWith("__Host-"), `${name}: __Host- prefix`);
    assert.match(line, /;\s*Secure/i, `${name}: Secure`);
    assert.match(line, /;\s*Path=\//i, `${name}: Path=/`);
    assert.doesNotMatch(line, /;\s*Domain=/i, `${name}: no Domain`);
    assert.match(line, /;\s*SameSite=Lax/i, `${name}: SameSite=Lax`);
  }
  const token = raw.find((line) => line.startsWith(`${SESSION_TOKEN_COOKIE}=`))!;
  assert.match(token, /;\s*HttpOnly/i, "the session token is not readable by page scripts");
});

test("no session fixation: signing in with a planted session cookie issues a fresh session, and the planted value is no session", async () => {
  const auth = instance();
  await signUp(auth, "victim@example.com");
  const planted = `${SESSION_TOKEN_COOKIE}=attacker-chosen-token.c2lnbmF0dXJl`;
  const { jar } = await signIn(auth, "victim@example.com", planted);
  const issued = jar.get(SESSION_TOKEN_COOKIE)!;
  assert.ok(issued && !issued.startsWith("attacker-chosen-token"), "a new token was issued");
  assert.equal(await serverSession(auth, planted), null, "the planted cookie is not a session");
  assert.ok(await serverSession(auth, cookieHeader(jar)), "the fresh one is");
});

test("sign-out ends the session on the server: the old cookies no longer reach mail", async () => {
  const auth = instance();
  const { jar } = await signUp(auth, "signout@example.com");
  const cookie = cookieHeader(jar);
  assert.ok(await serverSession(auth, cookie));
  const out = await post(auth, "/sign-out", {}, cookie);
  assert.equal(out.status, 200);
  // Someone who copied the cookies before sign-out (or a second tab replaying them) gets nothing.
  assert.equal(await serverSession(auth, cookie), null);
});

test("'Sign out all other devices' takes effect on the next server request, not after the 5-minute cookie cache", async () => {
  const auth = instance();
  const laptop = (await signUp(auth, "devices@example.com")).jar;
  const phone = (await signIn(auth, "devices@example.com")).jar;
  const phoneCookie = cookieHeader(phone);
  assert.ok(await serverSession(auth, phoneCookie));

  const revoke = await post(auth, "/revoke-other-sessions", {}, cookieHeader(laptop));
  assert.equal(revoke.status, 200, await revoke.clone().text());

  // The cached read (what the browser's /get-session uses) would still say signed in for up to 5 minutes:
  const cached = await auth.api.getSession({ headers: new Headers({ cookie: phoneCookie }) });
  assert.ok(cached, "the cookie cache still answers (expected; the browser only uses it to draw the screen)");
  // The server's check for mail does not use it:
  assert.equal(await serverSession(auth, phoneCookie), null, "the phone can no longer reach mail");
  assert.ok(await serverSession(auth, cookieHeader(laptop)), "the laptop still can");
});

test("the server's session check bypasses the cookie cache (verify.server.ts)", () => {
  const source = readFileSync(join(import.meta.dirname, "verify.server.ts"), "utf8");
  assert.match(source, /auth\.api\.getSession\(\{\s*headers,\s*query:\s*\{\s*disableCookieCache:\s*true\s*\}\s*\}\)/);
});

test("sign-in is rate limited per client on a deployed copy: the 11th attempt in a minute is refused", async () => {
  const auth = instance({ BETTER_AUTH_URL: BASE });
  await signUp(auth, "limited@example.com", "");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    const response = await post(auth, "/sign-in/email", { email: "limited@example.com", password: "wrong password!" }, "", "203.0.113.50");
    statuses.push(response.status);
  }
  assert.equal(statuses.at(-1), 429, statuses.join(","));
  // Another client is not affected.
  const other = await post(auth, "/sign-in/email", { email: "limited@example.com", password: "correct horse battery" }, "", "203.0.113.51");
  assert.equal(other.status, 200);
});
