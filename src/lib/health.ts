/**
 * `GET /api/health`: is this copy up, which build and region is it, and can it reach its database and
 * blob storage. It reports only yes/no, timings, the storage kind and a coarse error class: never a
 * connection string, host name, key or error message. Results are cached briefly so the endpoint cannot
 * be used to load the database. Checks are read-only.
 */
import { regionFor, type Region } from "./region.ts";

declare const __APP_COMMIT__: string | undefined;

export type Check = { ok: boolean; ms: number; error?: "timeout" | "unreachable" };

export type HealthReport = {
  status: "ok" | "degraded";
  service: "cumulus-mail";
  commit: string;
  region: Region;
  db: Check & { source?: "postgres" | "pglite" };
  storage: Check & { kind?: "filesystem" | "s3" };
  /** Only with `?deep=1`. Milliseconds per check; never a host, a query or an error message. */
  timings?: Timings;
  time: string;
};

/** Build commit: stamped at build time, else `APP_COMMIT` from the environment, else "unknown". */
export function buildCommit(env: { APP_COMMIT?: string } = process.env): string {
  const stamped = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "";
  const value = stamped || env.APP_COMMIT?.trim() || "unknown";
  return /^[0-9a-f]{7,40}$|^unknown$/i.test(value) ? value : "unknown";
}

export async function timed(run: () => Promise<boolean>, timeoutMs = 3000): Promise<Check> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { ok, ms: Date.now() - started, ...(ok ? {} : { error: "unreachable" as const }) };
  } catch (error) {
    const timeout = error instanceof Error && error.message === "timeout";
    return { ok: false, ms: Date.now() - started, error: timeout ? "timeout" : "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `?deep=1`: what each check cost, so a slow copy can be told from a broken one. */
export type Timings = { db: number; storage: number; total: number };

export type HealthDeps = {
  db: () => Promise<boolean>;
  dbSource: () => "postgres" | "pglite";
  storage: () => Promise<boolean>;
  storageKind: () => "filesystem" | "s3";
  now?: () => Date;
};

export async function healthReport(host: string | null, deps: HealthDeps, options: { deep?: boolean } = {}): Promise<HealthReport> {
  const started = Date.now();
  const [db, storage] = await Promise.all([timed(deps.db), timed(deps.storage)]);
  let source: "postgres" | "pglite" | undefined;
  let kind: "filesystem" | "s3" | undefined;
  try {
    source = deps.dbSource();
  } catch {
    source = undefined;
  }
  try {
    kind = deps.storageKind();
  } catch {
    kind = undefined;
  }
  return {
    status: db.ok && storage.ok ? "ok" : "degraded",
    service: "cumulus-mail",
    commit: buildCommit(),
    region: regionFor(host),
    db: { ...db, ...(source ? { source } : {}) },
    storage: { ...storage, ...(kind ? { kind } : {}) },
    ...(options.deep ? { timings: { db: db.ms, storage: storage.ms, total: Date.now() - started } } : {}),
    time: (deps.now?.() ?? new Date()).toISOString(),
  };
}

const CACHE_MS = 30_000;
let cached: { at: number; host: string; deep: boolean; report: HealthReport } | undefined;

/**
 * The report for a request, reusing one from the last 30 seconds for the same host. A `?deep=1` call
 * is cached separately: its whole point is a fresh measurement, so it must not be served a cached
 * one, nor hand its timings to a plain call.
 */
export async function cachedHealth(
  host: string | null,
  deps: HealthDeps,
  now = Date.now(),
  options: { deep?: boolean } = {},
): Promise<HealthReport> {
  const key = host ?? "";
  const deep = options.deep === true;
  if (cached && cached.host === key && cached.deep === deep && now - cached.at < CACHE_MS) return cached.report;
  const report = await healthReport(host, deps, { deep });
  cached = { at: now, host: key, deep, report };
  return report;
}

export function resetHealthCache(): void {
  cached = undefined;
}
