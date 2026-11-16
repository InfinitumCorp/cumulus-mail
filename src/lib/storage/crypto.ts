import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { blindKeyFromEnv, isKeyring, keyringFromEnv, openWith, sealWith, type Keyring } from "./keyring.ts";

/** One key (v1 only, as before) or a keyring (key-id'd values; see keyring.ts). */
export type Keys = Uint8Array | Keyring;

/** The keys values are sealed and opened with: MAIL_BLOB_KEYS, else MAIL_BLOB_KEY as key 0. */
export function sealingKeysFromEnv(env: Record<string, string | undefined> = process.env): Keyring {
  return keyringFromEnv(env);
}

const VERSION = 1;

/**
 * The STABLE key: blind indexes and share links are HMACs under keys derived from it, so it does not
 * rotate with MAIL_BLOB_KEYS (rotating it would mean rebuilding every lookup index). MAIL_BLIND_KEY when
 * set, else MAIL_BLOB_KEY, which is today's key, so every existing index stays valid.
 */
export function masterKeyFromEnv(env: Record<string, string | undefined> = process.env): Uint8Array {
  if (!env.MAIL_BLIND_KEY?.trim() && !env.MAIL_BLOB_KEY?.trim()) throw new Error("MAIL_BLOB_KEY is not set");
  try {
    return blindKeyFromEnv(env);
  } catch {
    throw new Error("MAIL_BLOB_KEY must be 32 bytes");
  }
}

/** Per-tenant AES-256 key. A different tenant id derives a different key. */
export function tenantKey(masterKey: Uint8Array, tenantId: string, purpose = "blob"): Buffer {
  return createHmac("sha256", Buffer.from(masterKey)).update(`cumulus-mail-${purpose}-v1\0${tenantId}`).digest();
}

function aadFor(purpose: string, tenantId: string): Buffer {
  return Buffer.from(purpose === "blob" ? tenantId : `${purpose}\0${tenantId}`);
}

export function seal(keys: Keys, tenantId: string, plaintext: Uint8Array, purpose = "blob"): Uint8Array {
  if (isKeyring(keys)) {
    // A configured keyring writes the key-id'd v2 layout; a bare MAIL_BLOB_KEY keeps writing v1.
    if (keys.explicit) return sealWith(keys, tenantId, plaintext, purpose);
    keys = keys.keys.get(0)!;
  }
  const masterKey = keys;
  const key = tenantKey(masterKey, tenantId, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(purpose, tenantId));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, body]));
}

export function openSeal(keys: Keys, tenantId: string, sealed: Uint8Array, purpose = "blob"): Uint8Array {
  if (isKeyring(keys)) return openWith(keys, tenantId, sealed, purpose);
  const masterKey = keys;
  if (sealed[0] !== VERSION || sealed.byteLength < 1 + 12 + 16) {
    throw new Error("Ciphertext is not a Cumulus mail blob");
  }
  const iv = Buffer.from(sealed.subarray(1, 13));
  const tag = Buffer.from(sealed.subarray(sealed.byteLength - 16));
  const data = Buffer.from(sealed.subarray(13, sealed.byteLength - 16));
  const decipher = createDecipheriv("aes-256-gcm", tenantKey(masterKey, tenantId, purpose), iv);
  decipher.setAAD(aadFor(purpose, tenantId));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}
