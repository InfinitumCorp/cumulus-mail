import { databaseUrl, getSql } from "@/lib/db";
import { isWorkersRuntime } from "@/lib/runtime";
import { createStorageDriver, openTenantStorage, type StorageDriver } from "@/lib/storage";
import type { TenantStorage } from "./delivery.ts";
import { missingIngestSettings, type IngestEnv } from "./ingest-settings.ts";
import type { MailQuery } from "./query.ts";

/**
 * The `{ db, storageFor }` pair the inbound email handler needs. It is the same
 * query surface and the same storage adapter the mailbox API uses, so a blob
 * written by inbound mail is read back by the API.
 */
export type InboundDeps = {
  db: MailQuery;
  storageFor: TenantStorage;
};

const globalDriver = globalThis as typeof globalThis & { __cumulusMailIngestDriver?: StorageDriver };

/**
 * Open the database and the blob store for inbound mail, or throw naming every
 * setting that is missing. One driver per isolate; a warm instance reuses it.
 */
export async function openIngest(env: IngestEnv = process.env): Promise<InboundDeps> {
  const missing = missingIngestSettings(env, {
    hasDatabase: Boolean(databaseUrl()),
    workers: isWorkersRuntime(),
  });
  if (missing.length > 0) {
    throw new Error(`Cumulus mail inbound ingest is not configured. Missing: ${missing.join(", ")}`);
  }
  const sql = await getSql();
  const db: MailQuery = { query: (text, params) => sql.query(text, params ?? []) };
  globalDriver.__cumulusMailIngestDriver ??= createStorageDriver(env);
  const driver = globalDriver.__cumulusMailIngestDriver;
  return { db, storageFor: (tenantId: string) => openTenantStorage(tenantId, driver) };
}

export { missingIngestSettings, type IngestEnv } from "./ingest-settings.ts";
