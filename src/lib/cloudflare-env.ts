type HyperdriveBinding = { connectionString?: string };

const COPIED = [
  "MAIL_BLOB_KEY",
  "MAIL_STORAGE",
  "MAIL_DOMAIN",
  "MAIL_APP_HOST",
  "MAIL_AUTH_DNS",
  "MAIL_S3_BUCKET",
  "MAIL_S3_ENDPOINT",
  "MAIL_S3_REGION",
  "MAIL_S3_ACCESS_KEY_ID",
  "MAIL_S3_SECRET_ACCESS_KEY",
  "SUPABASE_S3_BUCKET",
  "SUPABASE_S3_ENDPOINT",
  "SUPABASE_S3_REGION",
  "SUPABASE_S3_ACCESS_KEY_ID",
  "SUPABASE_S3_SECRET_ACCESS_KEY",
  "CUMULUS_ALLOW_SUPABASE",
  "CUMULUS_OIDC_ISSUER",
  "CUMULUS_OIDC_JWKS_URL",
  "CUMULUS_RUNTIME",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "VITE_AUTH_ENABLED",
  "GROK_AUTH_ISSUER",
  "GROK_AUTH_CLIENT_ID",
  "GROK_AUTH_CLIENT_SECRET",
] as const;

function bindingEnv(): Record<string, unknown> | undefined {
  const env = (globalThis as { __env__?: unknown }).__env__;
  if (!env || typeof env !== "object") return undefined;
  return env as Record<string, unknown>;
}

/**
 * Nitro's Cloudflare module handler assigns `globalThis.__env__` before the
 * request runs. Hyperdrive is a binding, so its connection string is not in
 * `process.env` until this copy. The binding wins over a static `DATABASE_URL`.
 * Values are not logged.
 */
export function applyWorkerBindings(): void {
  if (typeof process === "undefined") return;
  const env = bindingEnv();
  if (!env) return;
  const hyperdrive = env.HYPERDRIVE as HyperdriveBinding | undefined;
  const connectionString = hyperdrive?.connectionString?.trim();
  if (connectionString) process.env.DATABASE_URL = connectionString;
  for (const key of COPIED) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) process.env[key] = value;
  }
}
