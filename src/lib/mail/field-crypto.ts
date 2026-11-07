import { masterKeyFromEnv, openSeal, seal } from "../storage/crypto.ts";
import { tenantKey } from "../storage/crypto.ts";
import { createHmac } from "node:crypto";

const PREFIX = "cm1.";

/** AES-256-GCM for one Postgres field. The key is the tenant's meta key. */
export function sealText(tenantId: string, value: string, master: Uint8Array = masterKeyFromEnv()): string {
  const sealed = seal(master, tenantId, new TextEncoder().encode(value), "meta");
  return PREFIX + Buffer.from(sealed).toString("base64url");
}

/** Open a field. Legacy plaintext (no prefix) is returned unchanged. */
export function openText(tenantId: string, stored: string | null, master: Uint8Array = masterKeyFromEnv()): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  const sealed = Buffer.from(stored.slice(PREFIX.length), "base64url");
  return new TextDecoder().decode(openSeal(master, tenantId, sealed, "meta"));
}

/**
 * Equality index for a field. Message fields use the tenant key, so the same
 * subject in two mailboxes does not share an index value. Address routing
 * does not know the tenant yet, so pass `null` and the index is derived from
 * the master under the fixed scope `global`.
 */
export function blindIndex(
  tenantId: string | null,
  field: string,
  value: string,
  master: Uint8Array = masterKeyFromEnv(),
): string {
  const key = tenantKey(master, tenantId ?? "global", "blind");
  return createHmac("sha256", key).update(`${field}\0${value.trim().toLowerCase()}`).digest("hex");
}

export function isSealed(stored: string | null | undefined): boolean {
  return Boolean(stored?.startsWith(PREFIX));
}
