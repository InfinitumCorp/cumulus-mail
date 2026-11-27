// @ts-check
/** Pure parts of scripts/load/inbound-load.mjs: where it may point, and adding up several processes. */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Loopback runs as before (the S3 stand-in, fake keys). Anything else needs `--target staging` and the
 * bucket's real settings, so a stray DATABASE_URL in the shell can't send load somewhere unintended.
 * @param {{ databaseUrl: string, s3Endpoint: string, target: string, env: Record<string, string | undefined> }} input
 */
export function loadTarget({ databaseUrl, s3Endpoint, target, env }) {
  const remote = [hostOf(databaseUrl), hostOf(s3Endpoint)].filter((host) => !LOOPBACK.has(host));
  if (!remote.length) {
    return {
      s3: {
        SUPABASE_S3_REGION: "us-east-1",
        SUPABASE_S3_ACCESS_KEY_ID: "load",
        SUPABASE_S3_SECRET_ACCESS_KEY: "load",
        SUPABASE_S3_BUCKET: "cumulus-mail-load",
        MAIL_S3_LOOPBACK_ONLY: "1",
      },
    };
  }
  if (target !== "staging") return { error: `${remote.join(", ")} is not loopback: pass --target staging, and only for a staging database and bucket` };
  if (env.LOAD_PRODUCTION_DB_HOST && remote.includes(env.LOAD_PRODUCTION_DB_HOST.toLowerCase())) {
    return { error: `${env.LOAD_PRODUCTION_DB_HOST} is the production database (LOAD_PRODUCTION_DB_HOST)` };
  }
  const need = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"].filter((name) => !env[name]?.trim());
  if (need.length) return { error: `set ${need.join(", ")} for the staging bucket` };
  return {
    s3: {
      SUPABASE_S3_REGION: env.S3_REGION?.trim() || "us-east-1",
      SUPABASE_S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
      SUPABASE_S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
      SUPABASE_S3_BUCKET: env.S3_BUCKET,
    },
  };
}

/**
 * Add up child results: `stored` is each process's latencies in ms.
 * @param {Array<{ stored: number[], errors: number, errorKinds: Record<string, number>, peak: number, elapsed: number }>} results
 */
export function aggregate(results) {
  const latencies = results.flatMap((r) => r.stored).sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1) : "-");
  const errorKinds = {};
  for (const r of results) for (const [kind, count] of Object.entries(r.errorKinds)) errorKinds[kind] = (errorKinds[kind] ?? 0) + count;
  const elapsed = Math.max(...results.map((r) => r.elapsed), 0.001);
  return {
    stored: latencies.length,
    errors: results.reduce((sum, r) => sum + r.errors, 0),
    errorKinds,
    peak: results.reduce((sum, r) => sum + r.peak, 0),
    rate: latencies.length / elapsed,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: latencies.at(-1)?.toFixed(1) ?? "-",
  };
}
