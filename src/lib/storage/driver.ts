import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

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
  client: S3Client;
  bucket: string;
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

function missingObject(error: unknown): boolean {
  if (error instanceof NoSuchKey) return true;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === "NoSuchKey" || named.name === "NotFound" || named.$metadata?.httpStatusCode === 404;
}

/**
 * Same options and methods as Drive's `createS3Driver`. Bytes go to
 * `tenants/${tenantId}/${blobId}` through AWS SDK v3. `loopbackOnly` refuses
 * any endpoint that is not local. A `*.supabase.co` host is refused unless
 * `CUMULUS_ALLOW_SUPABASE=1`.
 *
 * Supabase Storage's S3 endpoint is `https://<project>.supabase.co/storage/v1/s3`.
 * That host needs `forcePathStyle` so the bucket stays in the path, and
 * `requestChecksumCalculation` / `responseChecksumValidation` of `WHEN_REQUIRED`.
 * AWS SDK v3's default flexible checksums are not accepted there. Both are set
 * below. Outbound mail does not use this driver.
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
  const client = new S3Client({
    region: options.region || "us-east-1",
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId ?? "",
      secretAccessKey: options.secretAccessKey ?? "",
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const bucket = options.bucket;
  const keyFor = (tenantId: string, blobId: string) => {
    assertIds(tenantId, blobId);
    return `tenants/${tenantId}/${blobId}`;
  };
  return {
    kind: "s3",
    client,
    bucket,
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async put(tenantId, blobId, bytes) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keyFor(tenantId, blobId),
          Body: bytes,
        }),
      );
    },
    async get(tenantId, blobId) {
      try {
        const out = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: keyFor(tenantId, blobId),
          }),
        );
        if (!out.Body) throw new BlobNotFoundError(blobId);
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (error) {
        if (missingObject(error)) throw new BlobNotFoundError(blobId);
        throw error;
      }
    },
    async delete(tenantId, blobId) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: keyFor(tenantId, blobId),
        }),
      );
    },
    async probe() {
      await this.ensureBucket();
      const blobId = "bb".padEnd(32, "0");
      await this.put("probe", blobId, Buffer.from("probe"));
      const got = await this.get("probe", blobId);
      await this.delete("probe", blobId);
      return got.toString() === "probe";
    },
  };
}

export function blobFile(root: string, tenantId: string, blobId: string): string {
  return location(root, tenantId, blobId);
}
