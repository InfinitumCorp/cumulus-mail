import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.trim().replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  if (!clean || [...clean].some((char) => !ALPHABET.includes(char))) throw new Error("Not a base32 secret");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes, the usual authenticator secret. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238, 6 digits, SHA-1, 30 second step. */
export function totpCode(secret: string, at = Date.now(), step = 30): string {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** True when `code` matches this step or one step either side. */
export function verifyTotpCode(secret: string, code: string, at = Date.now()): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const given = Buffer.from(clean);
  for (let delta = -1; delta <= 1; delta += 1) {
    const expected = Buffer.from(totpCode(secret, at + delta * 30_000));
    if (timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`Cumulus://Mail:${email}`);
  const query = new URLSearchParams({ secret, issuer: "Cumulus://Mail", algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** One-time codes. The mailbox stores only their SHA-256. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    return [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
  });
}

export function recoveryHash(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase().replace(/\s/g, "")).digest("hex");
}

export function recoveryMatches(hashes: string[], code: string): number {
  const hashed = recoveryHash(code);
  const given = Buffer.from(hashed);
  return hashes.findIndex((item) => item.length === hashed.length && timingSafeEqual(Buffer.from(item), given));
}
