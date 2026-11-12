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
    ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DATABASE_URL", "VITE_AUTH_ENABLED", "CID_ISSUER", "CID_ISSUER_RU", "CID_CLIENT_ID", "MAIL_REGION", "CUMULUS_RUNTIME"].map(
      (key) => value(env, key) ?? null,
    ),
  );
}
