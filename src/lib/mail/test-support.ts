import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { LocalDiskStorageDriver } from "../storage/local-disk.ts";
import { openTenantStorage } from "../storage/index.ts";
import type { TenantStorage } from "./delivery.ts";
import type { MailProfile } from "./snapshot.ts";
import type { MailQuery } from "./query.ts";

export async function createHarness() {
  const pg = new PGlite();
  await pg.waitReady;
  const sql = readFileSync(new URL("../../../migrations/0002_cumulus_mail.sql", import.meta.url), "utf8");
  await pg.exec(sql);
  const dir = await mkdtemp(join(tmpdir(), "cumulus-mail-"));
  const driver = new LocalDiskStorageDriver(dir);
  const db: MailQuery = {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  const storageFor: TenantStorage = (tenantId) => openTenantStorage(tenantId, driver);
  return {
    db,
    driver,
    storageFor,
    async close() {
      await pg.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function profile(tenantId: string, email: string, name = email.split("@")[0] || email): MailProfile {
  return { name, email, cid: `cid:${tenantId}`, plan: "Free", quotaGb: 15 };
}
