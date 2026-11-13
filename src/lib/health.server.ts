import { pendingMigrations } from "../../scripts/migration-plan.mjs";
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
    // Same glob as the PGLite migrator in db.ts, so the modules are shared. A database without
    // `_migrations` (undefined_table) has every migration pending; any other error is "unreachable".
    pendingMigrations: async () => {
      const files = Object.keys(
        import.meta.glob("/migrations/*.sql", { query: "?raw", import: "default", eager: true }),
      );
      const sql = await getSql();
      let applied: string[] = [];
      try {
        const rows = (await sql.query("select name from _migrations", [])) as Array<{ name: string }>;
        applied = rows.map((row) => row.name);
      } catch (error) {
        if ((error as { code?: string })?.code !== "42P01") throw error;
      }
      return pendingMigrations(files, applied).length;
    },
  }, Date.now(), { deep });
}
