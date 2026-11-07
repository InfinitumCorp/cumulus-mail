/**
 * Shared checks and hashing. The swappable driver lives in `driver.ts` and
 * matches Drive's `put(tenantId, blobId, bytes)` / `get` / `delete` / `probe`.
 */

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

/** Same tenant id shape Drive accepts. */
const TENANT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) throw new TenantAccessError("Invalid tenant");
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

export function sanitizeContentType(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[\r\n]/g, "").trim().slice(0, 200);
  return cleaned || "application/octet-stream";
}
