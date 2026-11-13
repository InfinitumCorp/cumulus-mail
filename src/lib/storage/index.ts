import { join } from "node:path";
import { applyWorkerBindings } from "../cloudflare-env.ts";
import { sha256Hex } from "./adapter.ts";
import { openSeal, seal, sealingKeysFromEnv, type Keys } from "./crypto.ts";
import {
  BlobNotFoundError,
  createFilesystemDriver,
  createS3Driver,
  newBlobId,
  type StorageDriver,
} from "./driver.ts";

export type { StorageDriver, S3DriverOptions, S3StorageDriver } from "./driver.ts";
export {
  BlobNotFoundError,
  blobObjectKey,
  createFilesystemDriver,
  createS3Driver,
  newBlobId,
} from "./driver.ts";
export { masterKeyFromEnv, openSeal, seal, sealingKeysFromEnv, tenantKey } from "./crypto.ts";
export { ChecksumMismatchError, TenantAccessError, assertTenantId, sha256Hex } from "./adapter.ts";

export type TenantBlobs = {
  put(plaintext: Uint8Array): Promise<{ blobId: string; sha256: string }>;
  get(blobId: string): Promise<{ body: Uint8Array; sha256: string } | null>;
  delete(blobId: string): Promise<void>;
};

export function createStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  applyWorkerBindings();
  const mode = (env.MAIL_STORAGE ?? "local").trim().toLowerCase();
  if (mode === "s3") {
    return createS3Driver({
      bucket:
        env.MAIL_S3_BUCKET?.trim() || env.SUPABASE_S3_BUCKET?.trim() || "cumulus-mail-preview",
      endpoint: env.MAIL_S3_ENDPOINT?.trim() || env.SUPABASE_S3_ENDPOINT?.trim() || undefined,
      region: env.MAIL_S3_REGION?.trim() || env.SUPABASE_S3_REGION?.trim() || "us-east-1",
      accessKeyId: env.MAIL_S3_ACCESS_KEY_ID?.trim() || env.SUPABASE_S3_ACCESS_KEY_ID?.trim(),
      secretAccessKey:
        env.MAIL_S3_SECRET_ACCESS_KEY?.trim() || env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim(),
      loopbackOnly: env.MAIL_S3_LOOPBACK_ONLY === "1",
    });
  }
  const root = env.MAIL_BLOB_DIR?.trim() || join(process.cwd(), ".data", "mail-blobs");
  return createFilesystemDriver(root);
}

/** Encrypt every byte before it reaches the driver. Decrypt on read. */
export function createSealedDriver(inner: StorageDriver, masterKey: Keys): StorageDriver {
  return {
    kind: inner.kind,
    async put(tenantId, blobId, bytes) {
      await inner.put(tenantId, blobId, seal(masterKey, tenantId, bytes));
    },
    async get(tenantId, blobId) {
      return openSeal(masterKey, tenantId, await inner.get(tenantId, blobId));
    },
    async delete(tenantId, blobId) {
      await inner.delete(tenantId, blobId);
    },
    async probe() {
      const blobId = "cc".padEnd(32, "0");
      await this.put("probe", blobId, Buffer.from("probe"));
      const got = await this.get("probe", blobId);
      await this.delete("probe", blobId);
      return Buffer.from(got).toString() === "probe";
    },
  };
}

/**
 * Blobs for one verified tenant. `tenantId` is closed over here. Callers pass
 * a blob id, not a tenant.
 */
export function openTenantStorage(
  tenantId: string,
  inner: StorageDriver = createStorageDriver(),
): TenantBlobs {
  const driver = createSealedDriver(inner, sealingKeysFromEnv());
  return {
    async put(plaintext) {
      const blobId = newBlobId();
      const sha256 = await sha256Hex(plaintext);
      await driver.put(tenantId, blobId, plaintext);
      return { blobId, sha256 };
    },
    async get(blobId) {
      try {
        const body = await driver.get(tenantId, blobId);
        return { body, sha256: await sha256Hex(body) };
      } catch (error) {
        if (
          error instanceof BlobNotFoundError ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          return null;
        throw error;
      }
    },
    async delete(blobId) {
      await driver.delete(tenantId, blobId);
    },
  };
}
