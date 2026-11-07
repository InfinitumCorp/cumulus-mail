import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Same call shape as Drive's storage driver in cumulus-exchange
 * `cloud/src/storage.mjs`: `put(tenantId, blobId, bytes)`, `get`, `delete`,
 * `probe`, and `kind`. Mail does not import that file.
 *
 * Blob ids are 32 hex characters. Tenant ids are `[A-Za-z0-9_-]{1,80}`.
 * Bytes are stored at `tenants/<tenantId>/<blobId>`. The SHA-256 check lives
 * in the mail service, against metadata, the same split Drive uses.
 */
export const TENANT_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const BLOB_ID = /^[a-f0-9]{32}$/;

export type StorageDriver = {
  kind: "filesystem" | "s3";
  put(tenantId: string, blobId: string, bytes: Uint8Array): Promise<void>;
  get(tenantId: string, blobId: string): Promise<Uint8Array>;
  delete(tenantId: string, blobId: string): Promise<void>;
  probe(): Promise<boolean>;
};

export class BlobNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(blobId: string) {
    super(`Blob not found: ${blobId}`);
    this.name = "BlobNotFoundError";
  }
}

export function assertIds(tenantId: string, blobId: string): void {
  if (!TENANT_ID.test(tenantId)) throw new Error("Unsafe tenant id");
  if (!BLOB_ID.test(blobId)) throw new Error("Unsafe blob id");
}

export function newBlobId(): string {
  return randomBytes(16).toString("hex");
}

function location(root: string, tenantId: string, blobId: string): string {
  assertIds(tenantId, blobId);
  const base = resolve(root);
  const full = resolve(base, "tenants", tenantId, blobId);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (!full.startsWith(prefix)) throw new Error("Blob path escaped the data directory");
  return full;
}

/** Atomic replace: write a sibling temp file, then rename it into place. */
async function atomicWrite(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${randomBytes(8).toString("hex")}.partial`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

export function createFilesystemDriver(root: string): StorageDriver {
  return {
    kind: "filesystem",
    async put(tenantId, blobId, bytes) {
      await atomicWrite(location(root, tenantId, blobId), bytes);
    },
    async get(tenantId, blobId) {
      return readFile(location(root, tenantId, blobId));
    },
    async delete(tenantId, blobId) {
      await rm(location(root, tenantId, blobId), { force: true });
    },
    async probe() {
      const blobId = "aa".padEnd(32, "0");
      await this.put("probe", blobId, Buffer.from("probe"));
      const got = await this.get("probe", blobId);
      await this.delete("probe", blobId);
      return got.toString() === "probe";
    },
  };
}

/** Same option fields as Drive's `createS3Driver`. */
export type S3DriverOptions = {
  region?: string;
  endpoint?: string;
  loopbackOnly?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket: string;
};

export type S3StorageDriver = StorageDriver & {
  ensureBucket(): Promise<void>;
};

function endpointHost(endpoint: string | undefined): string {
  if (!endpoint) return "";
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

/**
 * Same options and methods as Drive's `createS3Driver`, including
 * `ensureBucket`. This preview does not construct an S3 client and does not
 * send. Drive's copy sends `PutObjectCommand`, `GetObjectCommand`, and
 * `DeleteObjectCommand` with `Key: tenants/${tenantId}/${blobId}`, and it
 * defaults `region` to `us-east-1`.
 */
export function createS3Driver(options: S3DriverOptions): S3StorageDriver {
  const host = endpointHost(options.endpoint);
  if (/supabase\.co$/i.test(host) && process.env.CUMULUS_ALLOW_SUPABASE !== "1") {
    throw new Error("Refusing the live Supabase project");
  }
  if (options.loopbackOnly) {
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      throw new Error("S3 endpoint must be loopback");
    }
  }
  if (!options.bucket?.trim()) throw new Error("S3 driver requires a bucket");
  const region = options.region || "us-east-1";
  const refuse = async (): Promise<never> => {
    throw new Error(
      `S3 driver for bucket "${options.bucket}" (${region}) matches Drive's put/get/delete and does not send.`,
    );
  };
  return {
    kind: "s3",
    async ensureBucket() {
      await refuse();
    },
    async put(tenantId, blobId) {
      assertIds(tenantId, blobId);
      await refuse();
    },
    async get(tenantId, blobId): Promise<Uint8Array> {
      assertIds(tenantId, blobId);
      return refuse();
    },
    async delete(tenantId, blobId) {
      assertIds(tenantId, blobId);
      await refuse();
    },
    async probe() {
      await this.ensureBucket();
      return false;
    },
  };
}

export function blobFile(root: string, tenantId: string, blobId: string): string {
  return location(root, tenantId, blobId);
}
