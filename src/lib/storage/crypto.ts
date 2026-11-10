import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = 1;

export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const raw = env.MAIL_BLOB_KEY?.trim();
  if (!raw) throw new Error("MAIL_BLOB_KEY is not set");
  const bytes =
    raw.length === 64 && /^[a-f0-9]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("MAIL_BLOB_KEY must be 32 bytes");
  return new Uint8Array(bytes);
}

/** Per-tenant AES-256 key. A different tenant id derives a different key. */
export function tenantKey(masterKey: Uint8Array, tenantId: string, purpose = "blob"): Buffer {
  return createHmac("sha256", Buffer.from(masterKey)).update(`cumulus-mail-${purpose}-v1\0${tenantId}`).digest();
}

function aadFor(purpose: string, tenantId: string): Buffer {
  return Buffer.from(purpose === "blob" ? tenantId : `${purpose}\0${tenantId}`);
}

export function seal(masterKey: Uint8Array, tenantId: string, plaintext: Uint8Array, purpose = "blob"): Uint8Array {
  const key = tenantKey(masterKey, tenantId, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(purpose, tenantId));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, body]));
}

export function openSeal(masterKey: Uint8Array, tenantId: string, sealed: Uint8Array, purpose = "blob"): Uint8Array {
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
