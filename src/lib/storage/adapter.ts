/**
 * Blob storage contract for Cumulus://Mail.
 *
 * The swap point is {@link StorageDriver}. Its put/get/delete signature is the
 * one Mail will call on a future Drive driver. This file does not import Drive.
 *
 * Drive's unmerged driver (InfinitumCorp/cumulus-exchange#2) was not readable
 * from this environment (the repository returns 404). The signature below
 * follows the contract that pull request was described with: positional
 * put(key, body, options), get(key), and delete(key), with sha256 on the write.
 * Drive's S3 driver uses AWS SDK v3. Mail's S3 class implements the same three
 * methods and does not send.
 *
 * Mail-only extensions, which are not part of that driver: list, head, and a
 * stub signed share URL. The local-disk driver implements list and head.
 * Tenant ids are still applied here, from the verified session, as
 * `tenant/<tenantId>/<objectKey>`.
 */

export type PutOptions = {
  contentType?: string;
  /** Lowercase hex sha256 of `body`. Required. A mismatch is rejected before the write is visible. */
  checksumSha256: string;
};

export type StoredObject = {
  key: string;
  body: Uint8Array;
  contentType: string;
  checksumSha256: string;
  size: number;
};

export type ObjectHead = {
  /** Full key: `tenant/<tenantId>/<objectKey>`. */
  key: string;
  tenantId: string;
  objectKey: string;
  size: number;
  checksumSha256: string;
  contentType: string;
  updatedAt: string;
};

/**
 * Unscoped driver. Same method names a Drive driver is expected to expose.
 * Mailbox code uses {@link bindTenantStorage} so the tenant id from the
 * verified session is closed over and cannot be replaced per call.
 */
export interface StorageDriver {
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/** Local-disk extras. Not part of the Drive put/get/delete driver. */
export interface ListableStorage {
  list(prefix: string): Promise<ObjectHead[]>;
  head(key: string): Promise<ObjectHead | null>;
}

export function isListableStorage(driver: StorageDriver): driver is StorageDriver & ListableStorage {
  const candidate = driver as StorageDriver & Partial<ListableStorage>;
  return typeof candidate.list === "function" && typeof candidate.head === "function";
}

export interface StorageAdapter {
  put(objectKey: string, body: Uint8Array, options: PutOptions): Promise<void>;
  get(objectKey: string): Promise<StoredObject | null>;
  delete(objectKey: string): Promise<void>;
  /** Mail extension. Requires a listable driver (the local-disk one). */
  list(prefix?: string): Promise<ObjectHead[]>;
  /** Mail extension. Requires a listable driver (the local-disk one). */
  head(objectKey: string): Promise<ObjectHead | null>;
  /**
   * Stub share URL. It names the object and an expiry, and it is not signed
   * with a key. Callers must not treat it as authorization.
   */
  signedShareUrl(objectKey: string, expiresInSeconds?: number): Promise<string>;
}

export class TenantAccessError extends Error {
  readonly status = 403;
  constructor(message = "Tenant access denied") {
    super(message);
    this.name = "TenantAccessError";
  }
}

export class ChecksumMismatchError extends Error {
  readonly status = 409;
  constructor(key: string) {
    super(`Checksum mismatch for ${key}`);
    this.name = "ChecksumMismatchError";
  }
}

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) throw new TenantAccessError("Invalid tenant");
}

/** Relative object key. Rejects traversal and any attempt to name a tenant. */
export function normalizeObjectKey(objectKey: string): string {
  if (typeof objectKey !== "string" || objectKey.length === 0 || objectKey.length > 512) {
    throw new TenantAccessError("Invalid object key");
  }
  if (objectKey.startsWith("/") || objectKey.includes("\\") || objectKey.includes("\0")) {
    throw new TenantAccessError("Invalid object key");
  }
  const parts = objectKey.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === "tenant")) {
    throw new TenantAccessError("Invalid object key");
  }
  if (objectKey.endsWith(".cumulus-meta.json") || objectKey.includes(".tmp")) {
    throw new TenantAccessError("Invalid object key");
  }
  return parts.join("/");
}

export function storageKey(tenantId: string, objectKey: string): string {
  assertTenantId(tenantId);
  return `tenant/${tenantId}/${normalizeObjectKey(objectKey)}`;
}

export function splitStorageKey(key: string): { tenantId: string; objectKey: string } {
  const match = /^tenant\/([^/]+)\/(.+)$/.exec(key);
  if (!match?.[1] || !match[2]) throw new TenantAccessError("Invalid storage key");
  assertTenantId(match[1]);
  return { tenantId: match[1], objectKey: normalizeObjectKey(match[2]) };
}

export function sanitizeContentType(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[\r\n]/g, "").trim().slice(0, 200);
  return cleaned || "application/octet-stream";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checksumOf(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/**
 * Bind a driver to one verified tenant. Every key is prefixed with that tenant.
 * `objectKey` is a relative path; a caller cannot pass `tenant/<other>/...`.
 */
export function bindTenantStorage(driver: StorageDriver, tenantId: string): StorageAdapter {
  assertTenantId(tenantId);
  const prefix = `tenant/${tenantId}/`;

  function full(objectKey: string): string {
    return storageKey(tenantId, objectKey);
  }

  return {
    async put(objectKey, body, options) {
      await driver.put(full(objectKey), body, {
        contentType: sanitizeContentType(options.contentType),
        checksumSha256: options.checksumSha256,
      });
    },
    async get(objectKey) {
      return driver.get(full(objectKey));
    },
    async delete(objectKey) {
      return driver.delete(full(objectKey));
    },
    async list(objectPrefix = "") {
      if (!isListableStorage(driver)) {
        throw new Error("This storage driver exposes put, get, and delete only.");
      }
      const relative = objectPrefix.replace(/\/+$/g, "");
      const normalized = relative ? normalizeObjectKey(relative) : "";
      const listPrefix = normalized ? `${prefix}${normalized}` : prefix;
      const rows = await driver.list(listPrefix);
      return rows.filter((row) => {
        if (row.tenantId !== tenantId || !row.key.startsWith(prefix)) return false;
        if (!normalized) return true;
        return row.key === listPrefix || row.key.startsWith(`${listPrefix}/`);
      });
    },
    async head(objectKey) {
      if (!isListableStorage(driver)) {
        throw new Error("This storage driver exposes put, get, and delete only.");
      }
      return driver.head(full(objectKey));
    },
    async signedShareUrl(objectKey, expiresInSeconds = 300) {
      const key = full(objectKey);
      const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
      return `stub://cumulus-share/${key}?exp=${exp}&signed=0`;
    },
  };
}
