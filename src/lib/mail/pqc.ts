import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { bytesToBase64, base64ToBytes } from "./bytes.ts";

/** Hybrid seal marker. Classic OpenPGP stays the path when a recipient has no PQ key. */
export const HYBRID_PREFIX = "cmh1.";

const INFO = new TextEncoder().encode("cumulus-mail-hybrid-v1");
const WRAP_INFO = new TextEncoder().encode("cumulus-mail-pq-wrap-v1");
const INDEX_INFO = new TextEncoder().encode("cumulus-mail-index-v1");
/**
 * PBKDF2-SHA-256 rounds for the passphrase wrap. The server stores the wrapped secrets, so it is the
 * party that could test passphrases offline; 600,000 is OWASP's figure for this hash. Wraps made before
 * this used 100,000.
 *
 * New wraps are plain base64url, the format every build reads. #200 briefly wrote a "w2." prefix; a build
 * from before #200 (a rollback, a tab left open) rejects that value and, through sanitizeSettings, drops
 * the whole hybrid key on its next settings save. So the rounds are not marked: a wrap is opened at the
 * current rounds first and at the old ones if that fails. "w2." values still open, and the unlock upgrade
 * rewrites them unprefixed.
 */
export const WRAP_ITERATIONS = 600_000;
const LEGACY_WRAP_ITERATIONS = 100_000;
const WRAP_V2 = "w2.";

export type HybridPublic = { x25519Public: string; mlkemPublic: string };
export type HybridSecrets = { x25519Secret: Uint8Array; mlkemSecret: Uint8Array };
export type HybridKey = HybridPublic & { wrappedSecrets: string };

function view(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function b64(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function generateX25519(): Promise<{ secret: Uint8Array; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  if (!priv.d || !pub.x) throw new Error("X25519 key is missing");
  return { secret: fromB64(priv.d), publicKey: fromB64(pub.x) };
}

async function sharedX25519(secret: Uint8Array, myPublic: Uint8Array, theirPublic: Uint8Array): Promise<Uint8Array> {
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", d: b64(secret), x: b64(myPublic) },
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", x: b64(theirPublic) }, { name: "X25519" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
  return new Uint8Array(bits);
}

async function hkdf(ikm: Uint8Array, info: Uint8Array, salt?: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", view(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt ? view(salt) : new Uint8Array(), info: view(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function aesEncrypt(keyBytes: Uint8Array, plain: Uint8Array): Promise<{ iv: Uint8Array; box: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", view(keyBytes), "AES-GCM", false, ["encrypt"]);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: view(iv) }, key, view(plain)));
  return { iv, box };
}

async function aesDecrypt(keyBytes: Uint8Array, iv: Uint8Array, box: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", view(keyBytes), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: view(iv) }, key, view(box)));
}

async function wrapBytes(plain: Uint8Array, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", view(new TextEncoder().encode(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: view(salt), iterations: WRAP_ITERATIONS, hash: "SHA-256" }, base, 256);
  const mixed = await hkdf(new Uint8Array(bits), WRAP_INFO, salt);
  const { iv, box } = await aesEncrypt(mixed, plain);
  return b64(concat(salt, iv, box));
}

/** The secrets, and whether the stored wrap is already in the current form (current rounds, no prefix). */
async function unwrapBytes(packed: string, passphrase: string): Promise<{ plain: Uint8Array; current: boolean }> {
  if (packed.startsWith(WRAP_V2)) {
    return { plain: await unwrapAt(packed.slice(WRAP_V2.length), passphrase, WRAP_ITERATIONS), current: false };
  }
  try {
    return { plain: await unwrapAt(packed, passphrase, WRAP_ITERATIONS), current: true };
  } catch {
    return { plain: await unwrapAt(packed, passphrase, LEGACY_WRAP_ITERATIONS), current: false };
  }
}

async function unwrapAt(packed: string, passphrase: string, iterations: number): Promise<Uint8Array> {
  const bytes = fromB64(packed);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const box = bytes.slice(28);
  const base = await crypto.subtle.importKey("raw", view(new TextEncoder().encode(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: view(salt), iterations, hash: "SHA-256" }, base, 256);
  const mixed = await hkdf(new Uint8Array(bits), WRAP_INFO, salt);
  return aesDecrypt(mixed, iv, box);
}

/** ML-KEM-768 plus X25519. Secrets are wrapped with the passphrase and never stored raw. */
export async function generateHybrid(passphrase: string): Promise<HybridKey> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const x25519 = await generateX25519();
  const kem = ml_kem768.keygen();
  const packed = concat(
    new Uint8Array([0, x25519.secret.length]),
    x25519.secret,
    new Uint8Array([(kem.secretKey.length >> 8) & 0xff, kem.secretKey.length & 0xff]),
    kem.secretKey,
  );
  return {
    x25519Public: b64(x25519.publicKey),
    mlkemPublic: b64(kem.publicKey),
    wrappedSecrets: await wrapBytes(packed, passphrase),
  };
}

/** An old-rounds or "w2."-prefixed wrap, re-made in the current plain form; undefined when it is already current. */
export async function upgradeHybridWrap(wrappedSecrets: string, passphrase: string): Promise<string | undefined> {
  const { plain, current } = await unwrapBytes(wrappedSecrets, passphrase);
  return current ? undefined : wrapBytes(plain, passphrase);
}

export async function openHybridSecrets(wrappedSecrets: string, passphrase: string): Promise<HybridSecrets> {
  const { plain: packed } = await unwrapBytes(wrappedSecrets, passphrase);
  const xLen = packed[1] ?? 0;
  const x25519Secret = packed.slice(2, 2 + xLen);
  const mLen = ((packed[2 + xLen] ?? 0) << 8) | (packed[3 + xLen] ?? 0);
  const mlkemSecret = packed.slice(4 + xLen, 4 + xLen + mLen);
  if (x25519Secret.length !== 32 || mlkemSecret.length < 32) throw new Error("Wrapped key is not a hybrid secret");
  return { x25519Secret, mlkemSecret };
}

export function isHybrid(value: string): boolean {
  return value.startsWith(HYBRID_PREFIX);
}

/**
 * Hybrid encrypt: the AES key is HKDF(X25519 shared || ML-KEM shared).
 * Either secret alone does not open the message. Classic OpenPGP is unchanged for recipients without these keys.
 */
export async function sealHybrid(plain: Uint8Array, recipient: HybridPublic): Promise<string> {
  const ephemeral = await generateX25519();
  const ecc = await sharedX25519(ephemeral.secret, ephemeral.publicKey, fromB64(recipient.x25519Public));
  const enc = ml_kem768.encapsulate(fromB64(recipient.mlkemPublic));
  const key = await hkdf(concat(ecc, enc.sharedSecret), INFO);
  const { iv, box } = await aesEncrypt(key, plain);
  return HYBRID_PREFIX + b64(concat(ephemeral.publicKey, enc.cipherText, iv, box));
}

export async function openHybrid(sealed: string, secrets: HybridSecrets, myX25519Public: string): Promise<Uint8Array> {
  if (!isHybrid(sealed)) throw new Error("Not a hybrid message");
  const bytes = fromB64(sealed.slice(HYBRID_PREFIX.length));
  const ephPub = bytes.slice(0, 32);
  const kemCt = bytes.slice(32, 32 + 1088);
  const iv = bytes.slice(32 + 1088, 32 + 1088 + 12);
  const box = bytes.slice(32 + 1088 + 12);
  const ecc = await sharedX25519(secrets.x25519Secret, fromB64(myX25519Public), ephPub);
  const kem = ml_kem768.decapsulate(kemCt, secrets.mlkemSecret);
  const key = await hkdf(concat(ecc, kem), INFO);
  return aesDecrypt(key, iv, box);
}

export async function sealHybridText(plain: string, recipient: HybridPublic): Promise<string> {
  return sealHybrid(new TextEncoder().encode(plain), recipient);
}

export async function openHybridText(sealed: string, secrets: HybridSecrets, myX25519Public: string): Promise<string> {
  return new TextDecoder().decode(await openHybrid(sealed, secrets, myX25519Public));
}

/** Search tokens under a key derived from the passphrase. The same passphrase on another device matches. */
export async function indexKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", view(new TextEncoder().encode(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: view(salt), iterations: 10_000, hash: "SHA-256" }, base, 256);
  return hkdf(new Uint8Array(bits), INDEX_INFO, salt);
}

export async function blindToken(word: string, key: Uint8Array): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", view(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, view(new TextEncoder().encode(word))));
  return [...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function wordsOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > 40 || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 200) break;
  }
  return out;
}

export async function buildClientIndex(
  messages: Array<{ id: string; subject: string; body: string }>,
  key: Uint8Array,
): Promise<Record<string, string[]>> {
  const index: Record<string, string[]> = {};
  for (const message of messages) {
    for (const word of wordsOf(`${message.subject}\n${message.body}`)) {
      const token = await blindToken(word, key);
      (index[token] ??= []).push(message.id);
    }
  }
  return index;
}

export async function searchClientIndex(index: Record<string, string[]>, key: Uint8Array, query: string): Promise<string[]> {
  const tokens = await Promise.all(wordsOf(query).map((word) => blindToken(word, key)));
  if (!tokens.length) return [];
  const sets = tokens.map((token) => new Set(index[token] ?? []));
  const [first, ...rest] = sets;
  if (!first) return [];
  return [...first].filter((id) => rest.every((set) => set.has(id)));
}
