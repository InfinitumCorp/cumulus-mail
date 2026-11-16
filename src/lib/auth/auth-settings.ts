/**
 * How the Better Auth secret is chosen (server-only, dependency-free so it can be tested).
 *
 * A deployed app must sign sessions with `BETTER_AUTH_SECRET`. The random preview secret is only for
 * local development and the sandbox preview, where sessions live in the in-process PGLite and die
 * with the process anyway. On a deployment (a real `DATABASE_URL`, or the Cloudflare Workers runtime)
 * a missing secret is a configuration error: falling back to a random secret would sign sessions with
 * a key no other isolate or instance has, so people would be signed out at random. That fails loudly.
 */
type AuthEnv = Record<string, string | undefined>;

const value = (env: AuthEnv, key: string): string | undefined => env[key]?.trim() || undefined;

export class MissingAuthSecretError extends Error {
  constructor() {
    super(
      "BETTER_AUTH_SECRET is not set. A deployed app (DATABASE_URL set, or running on Cloudflare Workers) " +
        "must have it in the platform's secret store; it never falls back to a random secret.",
    );
    this.name = "MissingAuthSecretError";
  }
}

/** True on a deployment: a real database, or the Workers runtime. */
export function isDeployedRuntime(env: AuthEnv): boolean {
  return Boolean(value(env, "DATABASE_URL")) || value(env, "CUMULUS_RUNTIME") === "cloudflare";
}

/** The secret to sign sessions with. Throws on a deployment without `BETTER_AUTH_SECRET`. */
export function resolveAuthSecret(env: AuthEnv, previewSecret: () => string): string {
  const secret = value(env, "BETTER_AUTH_SECRET");
  if (secret) return secret;
  if (isDeployedRuntime(env)) throw new MissingAuthSecretError();
  return previewSecret();
}

/** The settings the auth instance is built from; a change in any of them builds a new instance. */
export function authSettingsKey(env: AuthEnv): string {
  return JSON.stringify(
    ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DATABASE_URL", "VITE_AUTH_ENABLED", "CID_ISSUER", "CID_ISSUER_RU", "CID_CLIENT_ID", "MAIL_REGION", "CUMULUS_RUNTIME", "BETTER_AUTH_IP_HEADERS", "BETTER_AUTH_TRUSTED_PROXIES"].map(
      (key) => value(env, key) ?? null,
    ),
  );
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9.:/_-]+$/.test(item));

/**
 * Where Better Auth reads the client IP for rate limiting and session records. Without a header it
 * falls back to ONE shared bucket per path, so a single client could rate-limit sign-in for everyone.
 *   - `BETTER_AUTH_IP_HEADERS` (comma list) when set;
 *   - on Cloudflare Workers, `cf-connecting-ip` (set by Cloudflare, not forgeable by the client);
 *   - otherwise `x-forwarded-for`, as set by the gateway in front (Yandex API Gateway, a load balancer).
 * `BETTER_AUTH_TRUSTED_PROXIES` lists proxies whose appended addresses may be skipped.
 */
export function authIpOptions(env: AuthEnv): { ipAddressHeaders: string[]; trustedProxies?: string[] } {
  const configured = list(env.BETTER_AUTH_IP_HEADERS);
  const headers = configured.length
    ? configured
    : value(env, "CUMULUS_RUNTIME") === "cloudflare"
      ? ["cf-connecting-ip"]
      : ["x-forwarded-for"];
  const proxies = list(env.BETTER_AUTH_TRUSTED_PROXIES);
  return proxies.length ? { ipAddressHeaders: headers, trustedProxies: proxies } : { ipAddressHeaders: headers };
}

/**
 * Better Auth's rate limiting. Its own default is "on when NODE_ENV=production", which a Worker does
 * not reliably have, so a deployed copy (BETTER_AUTH_URL set) turns it on explicitly. Sign-in is
 * limited hardest: 10 starts per minute per client (authIpOptions picks the client address).
 */
export function authRateLimit(env: Record<string, string | undefined>) {
  const deployed = Boolean(env.BETTER_AUTH_URL?.trim()) || env.NODE_ENV === "production";
  return {
    enabled: deployed,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/*": { window: 60, max: 10 },
      "/oauth2/callback/*": { window: 60, max: 20 },
      "/callback/*": { window: 60, max: 20 },
    },
  };
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Origins Better Auth trusts for credentialed POSTs and for callbackURL redirects. A deployed copy
 * trusts only its own origin. The local development origins are added only when that origin is itself
 * local, so production never accepts a callbackURL on the user's own machine.
 */
export function deployedTrustedOrigins(explicitBaseURL: string, localDevOrigins: readonly string[]): string[] {
  const own = explicitBaseURL.trim().replace(/\/+$/, "");
  return LOOPBACK.test(own) ? [own, ...localDevOrigins] : [own];
}
