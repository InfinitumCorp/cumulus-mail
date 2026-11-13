import { getDbSource, getSql } from "./db";
import { cachedHealth, type HealthReport } from "./health.ts";
import { BlobNotFoundError, createStorageDriver } from "./storage";

const PROBE_TENANT = "health-probe";
const PROBE_BLOB = "0".repeat(32);

/** Read-only checks against this copy's own database and blob store. */
export function healthForRequest(request: Request): Promise<HealthReport> {
  // `?deep=1` asks for the per-check latency breakdown (and is measured, not served from the cache).
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  return cachedHealth(request.headers.get("host"), {
    db: async () => {
      const sql = await getSql();
      const rows = (await sql.query("select 1 as ok", [])) as Array<{ ok: number }>;
      return Number(rows[0]?.ok) === 1;
    },
    dbSource: () => (getDbSource() === "pglite" ? "pglite" : "postgres"),
    // A blob that never exists: "not found" proves the store answered. Nothing is written.
    storage: async () => {
      try {
        await createStorageDriver().get(PROBE_TENANT, PROBE_BLOB);
        return true;
      } catch (error) {
        if (error instanceof BlobNotFoundError || (error as { code?: string })?.code === "ENOENT") return true;
        if ((error as { name?: string })?.name === "NoSuchKey") return true;
        throw error;
      }
    },
    storageKind: () => createStorageDriver().kind,
  }, Date.now(), { deep });
}
