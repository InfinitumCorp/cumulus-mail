/**
 * Self-hosted Better Auth for THIS app (server-only).
 *
 * The app runs its own Better Auth at `/api/auth/*`, so the session cookie stays
 * on this app's own origin. People sign in with **Cumulus ID** only
 * (https://id.cumuluscloud.app, or `CID_ISSUER` for a mirror that loads in
 * Russia): a `genericOAuth` provider runs authorization code + PKCE against it
 * as the public client `cumulus-mail` (`CID_CLIENT_ID`). There is no local
 * email/password, passcode or PIN; people without a Cumulus ID create one on
 * the issuer's page in the same flow and come back here signed in.
 *
 * Modes:
 *   - Deployed: `BETTER_AUTH_URL` + `BETTER_AUTH_SECRET` + `DATABASE_URL`, so
 *     sessions persist in Postgres.
 *   - Local / preview: sessions persist in the embedded PGLite DB; the process
 *     restart wipes them. Live-preview iframe clients use a bearer token
 *     (partitioned cookies) - see `client.ts`.
 *   - Off (`VITE_AUTH_ENABLED=false`): no providers; `requireUserId` resolves a
 *     dev user with no database configured, and throws fail-closed once
 *     `DATABASE_URL` is set (see `verify.server.ts`).
 *
 * NEVER import this from client code - it pulls in `pg` and server-only Better
 * Auth internals. The client uses `@/lib/auth/client`; components read the user
 * via `@/lib/auth/use-current-user`; server functions get a verified id via
 * `@/lib/auth/middleware`.
 */
import { betterAuth } from "better-auth";
import { bearer, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { ensureDbReady, getPglite } from "../db";
import { cidConfig, cidConfigForRegion, cidProfileFromTokens, cidUserInfo, exchangeCidCode, cidAuthorizeUrl, cidTokenUrl } from "./cumulus-id.ts";
import { regionFor, type Region } from "../region.ts";
import { GATE_PROVIDER_ID, gateIdentitySessions } from "./gate-session.server";
import { SIGN_IN_PROVIDERS } from "./providers";
import { pgliteDialect } from "./pglite-dialect";
import { PREVIEW_ALLOWED_HOSTS } from "./preview";
import { applyWorkerBindings } from "../cloudflare-env.ts";
import { authIpOptions, authSettingsKey, resolveAuthSecret } from "./auth-settings.ts";

// Kick (and share) PGLite bootstrap as soon as the auth server module loads.
void ensureDbReady();

/**
 * Preview secret must outlive module reloads: PGLite (and its session rows) is
 * stored on `globalThis`, so an HMR re-eval of this file must NOT mint a new
 * signing secret or every existing session becomes invalid mid-dev. Process
 * restart clears both the secret and PGLite together.
 */
const globalAuthRef = globalThis as typeof globalThis & {
  __grokAuthPreviewSecret__?: string;
};
function previewAuthSecret(): string {
  globalAuthRef.__grokAuthPreviewSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__grokAuthPreviewSecret__;
}

/** Read an env var, treating empty/whitespace as unset. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

/** Session token cookie name — also read by the live-preview popup completion page. */
export const SESSION_TOKEN_COOKIE = "__Host-grok-auth.session_token";

/**
 * Build the Better Auth instance from the current settings. Called lazily (see `getAuth`), never at
 * module load: on Cloudflare Workers the settings are bindings that only reach `process.env` once a
 * request has started, so reading them at load could miss `BETTER_AUTH_SECRET` and `DATABASE_URL`.
 */
function buildAuth(region: Region) {
  // Explicit off-switch. The deployer sets `VITE_AUTH_ENABLED=true` when it
  // provisions auth; set it to "false" to force auth off everywhere (dev user).
  const authDisabled = env("VITE_AUTH_ENABLED") === "false";

  // Cumulus ID: issuer and public client id. Neither is a secret.
  const cid = cidConfigForRegion(region);

  /** True when Cumulus ID sign-in is active (real auth is enforced). */
  const authConfigured = !authDisabled && Boolean(cid.clientId);

  // This app's own Better Auth origin. When deployed the deployer injects the
  // public URL. In the sandbox live preview there's no fixed URL (each preview gets
  // a dynamic `*.grok-sandbox.com` host), so we hand Better Auth a dynamic baseURL:
  // it derives the origin per-request from the (proxied) host, validated against the
  // preview allowlist, which makes the OAuth `redirect_uri` the concrete preview URL.
  // Cumulus ID only returns codes to origins nexus lists for `cumulus-mail`.
  const explicitBaseURL = env("BETTER_AUTH_URL");
  // Explicit `string[]` (not a readonly tuple) — Better Auth's DynamicBaseURLConfig
  // requires a mutable `allowedHosts: string[]`.
  const previewAllowedHosts: string[] = [...PREVIEW_ALLOWED_HOSTS];
  // Local `npm run dev` (port 8080 contract). Browsers may send Origin as any of
  // these for the same server — trusting only `localhost` rejects `127.0.0.1` and
  // breaks sign-in with "Invalid origin".
  const LOCAL_DEV_ORIGINS: string[] = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ];
  const baseURL = explicitBaseURL ?? {
    // Include loopback hosts so dynamic baseURL resolves for local sign-in
    // (not only the preview wildcard).
    allowedHosts: [...previewAllowedHosts, "localhost", "127.0.0.1", "[::1]"],
    // `auto` → trust both http:// and https:// expansions of allowedHosts
    // (preview is https; local dev is http).
    protocol: "auto" as const,
    fallback: "http://localhost:8080",
  };

  // Origins Better Auth accepts on credentialed POSTs (sign-up/sign-in, etc.).
  // Missing entries here surface as FORBIDDEN "Invalid origin".
  // id.cumuluscloud.app, drive.cumuluscloud.app, and mail.cumuluscloud.app are not
  // listed. They are identity, Drive, and mailbox hosts, not this app's cookie origin, and
  // a wildcard would collapse cookie separation across those hosts.
  const trustedOrigins: string[] = explicitBaseURL
    ? [explicitBaseURL, ...LOCAL_DEV_ORIGINS]
    : [
        // Host wildcards (matched against Origin's host)
        ...previewAllowedHosts,
        // Full-origin wildcards (matched against Origin)
        ...previewAllowedHosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
        ...LOCAL_DEV_ORIGINS,
      ];

  const databaseUrl = env("DATABASE_URL");

  // Real Postgres when `DATABASE_URL` is set (deployed apps), else the app's
  // embedded PGLite (preview) via a Kysely dialect — so Better Auth persists to the
  // SAME DB as app data. Both use the Better Auth
  // schema from `migrations/auth/0001_auth.sql`, copied into `migrations/` when
  // the app turns sign-in on.
  const database = databaseUrl
    ? new Pool({ connectionString: databaseUrl })
    : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };

  // Built separately so the `betterAuth({...})` call stays easy to edit.
  // Both providers are the same Cumulus ID client; the "create" one adds
  // `prompt=create` so the issuer opens on "Create a Cumulus ID".
  const cumulusIdPlugin = authConfigured
    ? genericOAuth({
        config: SIGN_IN_PROVIDERS.map(({ providerId, create }) => ({
          providerId,
          clientId: cid.clientId,
          authorizationUrl: cidAuthorizeUrl(cid.issuer),
          pkce: true,
          // offline_access: a rotating refresh token, so the session list and key
          // directory keep working after the one-hour access token expires.
          scopes: ["openid", "profile", "email", "offline_access"],
          // Used only for refresh (the code exchange is getToken below). Public
          // client: Better Auth sends client_id and no secret.
          tokenUrl: cidTokenUrl(cid.issuer),
          ...(create ? { authorizationUrlParams: { prompt: "create" } } : {}),
          // Cumulus ID's token endpoint takes JSON and returns the profile with
          // the token, so redeem and read the person ourselves.
          getToken: (data) => exchangeCidCode(cid, data),
          getUserInfo: async (tokens) => {
            const profile = await cidProfileFromTokens(cid, tokens);
            return profile ? cidUserInfo(profile) : null;
          },
        })),
      })
    : null;

  const instance = betterAuth({
    baseURL,
    // Deployed apps inject BETTER_AUTH_SECRET; without it a deployment throws
    // (auth-settings.ts). Preview: process-stable secret on globalThis so HMR
    // doesn't invalidate PGLite-backed sessions (see above).
    secret: resolveAuthSecret(process.env, previewAuthSecret),
    database,

    // CSRF / origin check for credentialed auth POSTs (sign-in, sign-out, …).
    // See `trustedOrigins` construction above — must cover live preview hosts AND
    // local loopback variants, or clients get "Invalid origin".
    trustedOrigins,

    // Encrypt Cumulus ID tokens at rest, and treat Cumulus ID as the trusted
    // first-party identity: "sign in" and "create" are the same CID, so they link
    // to one user instead of failing with `account_not_linked`.
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: [
          ...SIGN_IN_PROVIDERS.map((p) => p.providerId),
          GATE_PROVIDER_ID,
        ],
        requireLocalEmailVerified: false,
      },
    },

    // Cache the session in the short-lived signed `session_data` cookie so reads
    // (incl. the client's `/get-session`) skip the DB — this shrinks the "loading"
    // window and reduces auth flicker. See the `auth` skill for the full
    // flicker-prevention guidance (gate on `isPending`; SSR the session).
    session: { cookieCache: { enabled: true, maxAge: 300 } },

    // No local email/password: Cumulus ID is the only way people sign in.
    emailAndPassword: { enabled: false },

    // `__Host-` prefixed cookies: the browser REFUSES any same-named cookie that
    // carries a `Domain` attribute, so a sibling `*.grok.me` app cannot "toss" a
    // `Domain=.grok.me` session cookie onto this app. `__Host-` requires Secure +
    // Path=/ + no Domain; Better Auth otherwise uses `__Secure-` (which permits
    // Domain), so we drop its auto prefix (`useSecureCookies: false`) and set
    // Secure + the names ourselves. (Browsers allow Secure cookies on
    // `http://localhost`, so local dev still works.)
    advanced: {
      // Per-client rate limiting: see authIpOptions (cf-connecting-ip on Workers).
      ipAddress: authIpOptions(process.env),
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
      cookies: {
        session_token: { name: SESSION_TOKEN_COOKIE },
        session_data: { name: "__Host-grok-auth.session_data" },
        account_data: { name: "__Host-grok-auth.account_data" },
        dont_remember: { name: "__Host-grok-auth.dont_remember" },
      },
    },

    plugins: [
      gateIdentitySessions(),

      // Cumulus ID (when auth is on).
      ...(cumulusIdPlugin ? [cumulusIdPlugin] : []),

      // Accept `Authorization: Bearer <session-token>` as an alternative to the
      // cookie. Needed for the LIVE PREVIEW: the app runs in an embedded iframe
      // where cookies are partitioned, so after popup sign-in it authenticates with
      // a bearer token instead (see `client.ts` / the `auth` skill). The hook only
      // fires when an Authorization header is present, so the cookie path
      // (deployed apps) is unaffected.
      bearer(),

      // Bridges Better Auth's Set-Cookie into TanStack Start responses. MUST be
      // last so it runs after every other plugin's hooks.
      tanstackStartCookies(),
    ],
  });
  return instance;
}

type AuthInstance = ReturnType<typeof buildAuth>;
const built = new Map<string, AuthInstance>();

/**
 * The Better Auth instance for the current settings and a region: Worker bindings are copied into
 * `process.env` first, then one instance is kept per settings value and region (normally at most two
 * per process or isolate). The region decides the Cumulus ID issuer: ru.* hosts sign in through the
 * Russia mirror. Sessions live in the shared database, so either instance verifies any session.
 */
export function getAuth(region: Region = regionFor(null)): AuthInstance {
  applyWorkerBindings();
  const key = `${region}|${authSettingsKey(process.env)}`;
  let instance = built.get(key);
  if (!instance) {
    if (built.size >= 8) built.clear();
    instance = buildAuth(region);
    built.set(key, instance);
  }
  return instance;
}

/** The instance for the host a request came to (sign-in, callbacks, the popup). */
export function authForRequest(request: Request): AuthInstance {
  applyWorkerBindings();
  return getAuth(regionFor(request.headers.get("host")));
}

/**
 * `auth.handler(...)`, `auth.api.getSession(...)` and the rest, resolved on first use rather than at
 * import, so existing call sites keep working. It uses this deployment's default region
 * (`MAIL_REGION`, else us); request handlers that start a sign-in use `authForRequest` instead.
 */
export const auth: AuthInstance = new Proxy({} as AuthInstance, {
  get: (_target, property) => Reflect.get(getAuth() as object, property),
});

/** True when Cumulus ID sign-in is active (real auth is enforced). Read per call, after bindings. */
export function isAuthConfigured(): boolean {
  applyWorkerBindings();
  return process.env.VITE_AUTH_ENABLED?.trim() !== "false" && Boolean(cidConfig().clientId);
}

export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}

// Re-exported for convenience; the array lives in the dependency-free
// `providers.ts` so the client can import it too.
export { SIGN_IN_PROVIDERS } from "./providers";
