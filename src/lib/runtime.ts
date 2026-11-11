/**
 * Which runtime the server half is executing in, and how to reach the
 * Cloudflare bindings that are not environment variables.
 *
 * `nodejs_compat` fills `process.env` from the Worker's `[vars]` and secrets,
 * so plain settings need nothing special. Object bindings (Hyperdrive, KV, R2)
 * are not strings and never appear there. Nitro's Cloudflare handler assigns
 * the whole `env` to `globalThis.__env__` on every invocation — fetch,
 * scheduled and email alike — which is the only place those bindings exist.
 */

/** True inside workerd (Cloudflare Workers), false under Node. */
export function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/** The Worker `env` for this invocation, or undefined under Node. */
export function workerEnv(): Record<string, unknown> | undefined {
  const holder = globalThis as typeof globalThis & { __env__?: Record<string, unknown> };
  return holder.__env__;
}

/**
 * A Hyperdrive binding's connection string. Hyperdrive pools and caches in
 * front of the shared Supabase Postgres; it is on the free plan. Without the
 * binding the app falls back to `DATABASE_URL`, which `pg` can also reach from
 * a Worker over `cloudflare:sockets`.
 */
export function hyperdriveConnectionString(binding = "MAIL_DB"): string | undefined {
  const value = workerEnv()?.[binding] as { connectionString?: unknown } | undefined;
  const connectionString = value && typeof value === "object" ? value.connectionString : undefined;
  return typeof connectionString === "string" && connectionString.trim() ? connectionString : undefined;
}
