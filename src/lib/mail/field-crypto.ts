import { masterKeyFromEnv, openSeal, seal, sealingKeysFromEnv, type Keys } from "../storage/crypto.ts";
import { tenantKey } from "../storage/crypto.ts";
import { createHmac } from "node:crypto";

const PREFIX = "cm1.";

/** AES-256-GCM for one Postgres field. The key is the tenant's meta key. */
export function sealText(tenantId: string, value: string, master: Keys = sealingKeysFromEnv()): string {
  const sealed = seal(master, tenantId, new TextEncoder().encode(value), "meta");
  return PREFIX + Buffer.from(sealed).toString("base64url");
}

/** Open a field. Legacy plaintext (no prefix) is returned unchanged. */
export function openText(tenantId: string, stored: string | null, master: Keys = sealingKeysFromEnv()): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  const sealed = Buffer.from(stored.slice(PREFIX.length), "base64url");
  return new TextDecoder().decode(openSeal(master, tenantId, sealed, "meta"));
}

/**
 * Equality index for one tenant. The HMAC key is that tenant's blind key,
 * derived from the master and the tenant id. The same address in two
 * mailboxes does not share an index value. Routing does not call this with a
 * master-only key; see `directory.ts`.
 */
export function blindIndex(
  tenantId: string,
  field: string,
  value: string,
  master: Uint8Array = masterKeyFromEnv(),
): string {
  const key = tenantKey(master, tenantId, "blind");
  return createHmac("sha256", key).update(`${field}\0${value.trim().toLowerCase()}`).digest("hex");
}

export function isSealed(stored: string | null | undefined): boolean {
  return Boolean(stored?.startsWith(PREFIX));
}
