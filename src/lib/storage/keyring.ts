/**
 * Key versioning for MAIL_BLOB_KEY (docs/design/blob-key-rotation.md). DRAFT: these functions are not yet
 * wired into seal/openSeal, so nothing reads or writes the new layout in production yet.
 *
 * Layout v2: [0x02][key id][iv 12][ciphertext][tag 16]. The key id is bound into the GCM additional data,
 * so a value cannot be relabelled with another key's id. Version-1 values ([0x01][iv]…, everything stored
 * today) have no id and are read as key id 0.
 *
 * MAIL_BLOB_KEYS = "2:<key>,1:<key>,0:<key>": an ordered list, the FIRST is current (used for writes), the
 * rest decrypt only. Keys are 32 bytes, hex or base64. Without it, MAIL_BLOB_KEY alone is key 0 and current.
 *
 * Blind indexes (address routing, aliases, suppressions, search) are NOT keyed from this list: they stay on
 * their own stable key, so a rotation never has to rebuild a lookup index (see blindKeyFromEnv).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type Keyring = { current: number; keys: Map<number, Uint8Array> };

function parseKey(raw: string): Uint8Array {
  const value = raw.trim();
  const bytes = value.length === 64 && /^[a-f0-9]+$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("Each MAIL_BLOB_KEYS key must be 32 bytes");
  return new Uint8Array(bytes);
}

export function keyringFromEnv(env: Record<string, string | undefined> = process.env): Keyring {
  const list = env.MAIL_BLOB_KEYS?.trim();
  if (!list) {
    const single = env.MAIL_BLOB_KEY?.trim();
    if (!single) throw new Error("MAIL_BLOB_KEY is not set");
    return { current: 0, keys: new Map([[0, parseKey(single)]]) };
  }
  const keys = new Map<number, Uint8Array>();
  let current = -1;
  for (const entry of list.split(",")) {
    const match = /^\s*(\d{1,3}):(.+)$/.exec(entry);
    if (!match) throw new Error("MAIL_BLOB_KEYS entries are <id>:<key>");
    const id = Number(match[1]);
    if (id > 255) throw new Error("Key ids are 0-255");
    if (keys.has(id)) throw new Error(`Key id ${id} appears twice`);
    keys.set(id, parseKey(match[2]!));
    if (current < 0) current = id;
  }
  return { current, keys };
}

const tenantKey = (master: Uint8Array, tenantId: string, purpose: string) =>
  createHmac("sha256", Buffer.from(master)).update(`cumulus-mail-${purpose}-v1\0${tenantId}`).digest();

/** The same AAD as v1, plus the key id for v2. */
function aad(purpose: string, tenantId: string, keyId?: number): Buffer {
  const base = purpose === "blob" ? tenantId : `${purpose}\0${tenantId}`;
  return Buffer.from(keyId === undefined ? base : `${base}\0k${keyId}`);
}

/** Seal with the current key, v2 layout. */
export function sealWith(ring: Keyring, tenantId: string, plaintext: Uint8Array, purpose = "blob"): Uint8Array {
  const master = ring.keys.get(ring.current);
  if (!master) throw new Error("The current key is missing from the keyring");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tenantKey(master, tenantId, purpose), iv);
  cipher.setAAD(aad(purpose, tenantId, ring.current));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([Buffer.from([2, ring.current]), iv, body]));
}

/** Which key sealed a value: its id, or 0 for v1. Null for something that is not a sealed value. */
export function sealedKeyId(sealed: Uint8Array): number | null {
  if (sealed[0] === 1 && sealed.byteLength >= 1 + 12 + 16) return 0;
  if (sealed[0] === 2 && sealed.byteLength >= 2 + 12 + 16) return sealed[1]!;
  return null;
}

/** Open a v1 or v2 value with whichever key in the ring sealed it. Fails if that key is gone. */
export function openWith(ring: Keyring, tenantId: string, sealed: Uint8Array, purpose = "blob"): Uint8Array {
  const keyId = sealedKeyId(sealed);
  if (keyId === null) throw new Error("Ciphertext is not a Cumulus mail blob");
  const master = ring.keys.get(keyId);
  if (!master) throw new Error(`Sealed with key ${keyId}, which is not in MAIL_BLOB_KEYS`);
  const offset = sealed[0] === 2 ? 2 : 1;
  const iv = Buffer.from(sealed.subarray(offset, offset + 12));
  const tag = Buffer.from(sealed.subarray(sealed.byteLength - 16));
  const data = Buffer.from(sealed.subarray(offset + 12, sealed.byteLength - 16));
  const decipher = createDecipheriv("aes-256-gcm", tenantKey(master, tenantId, purpose), iv);
  decipher.setAAD(aad(purpose, tenantId, sealed[0] === 2 ? keyId : undefined));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

/** Re-seal under the current key, or return null when it already is (so a re-key run is idempotent). */
export function resealed(ring: Keyring, tenantId: string, sealed: Uint8Array, purpose = "blob"): Uint8Array | null {
  if (sealed[0] === 2 && sealed[1] === ring.current) return null;
  return sealWith(ring, tenantId, openWith(ring, tenantId, sealed, purpose), purpose);
}

/**
 * The key blind indexes are computed under. It does not rotate with MAIL_BLOB_KEYS: MAIL_BLIND_KEY when
 * set, else MAIL_BLOB_KEY (today's key, so existing indexes stay valid). Rebuilding every lookup index on
 * each rotation is what this avoids; the cost is that this key must be kept as long as the indexes exist.
 */
export function blindKeyFromEnv(env: Record<string, string | undefined> = process.env): Uint8Array {
  const raw = env.MAIL_BLIND_KEY?.trim() || env.MAIL_BLOB_KEY?.trim();
  if (!raw) throw new Error("MAIL_BLIND_KEY or MAIL_BLOB_KEY must be set");
  return parseKey(raw);
}
