import { join } from "node:path";
import { bindTenantStorage, type StorageAdapter, type StorageDriver } from "./adapter.ts";
import { LocalDiskStorageDriver } from "./local-disk.ts";
import { S3CompatibleStorageDriver } from "./s3-stub.ts";

export type { ObjectHead, PutOptions, StorageAdapter, StorageDriver, StoredObject } from "./adapter.ts";
export { ChecksumMismatchError, TenantAccessError, bindTenantStorage, checksumOf, sha256Hex, storageKey } from "./adapter.ts";
export { LocalDiskStorageDriver } from "./local-disk.ts";
export { S3CompatibleStorageDriver } from "./s3-stub.ts";

/**
 * `MAIL_STORAGE=local` (default) uses the disk under `MAIL_BLOB_DIR` or
 * `.data/mail-blobs`. `MAIL_STORAGE=s3` returns the stub driver.
 */
export function createStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  const mode = (env.MAIL_STORAGE ?? "local").trim().toLowerCase();
  if (mode === "s3") {
    return new S3CompatibleStorageDriver({
      bucket: env.MAIL_S3_BUCKET?.trim() || "cumulus-mail-preview",
      endpoint: env.MAIL_S3_ENDPOINT?.trim() || undefined,
      region: env.MAIL_S3_REGION?.trim() || "auto",
    });
  }
  const root = env.MAIL_BLOB_DIR?.trim() || join(process.cwd(), ".data", "mail-blobs");
  return new LocalDiskStorageDriver(root);
}

/** Bind the process driver to a tenant id that came from a verified session. */
export function openTenantStorage(tenantId: string, driver: StorageDriver = createStorageDriver()): StorageAdapter {
  return bindTenantStorage(driver, tenantId);
}
