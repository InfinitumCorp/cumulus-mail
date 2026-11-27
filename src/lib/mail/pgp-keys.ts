import { bytesToBase64 } from "./bytes.ts";
import type { MailSettings } from "./settings.ts";

type OpenPgp = typeof import("openpgp");

async function lib(): Promise<OpenPgp> {
  return import("openpgp");
}

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** z-base32 (RFC 6189). SHA-1 is 160 bits, so WKD hashes have no leftover bits. */
export function zBase32Encode(data: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ZBASE32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += ZBASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** RFC 7929: SHA-1 of the lowercased local part, then z-base32. */
export async function wkdLocalHash(localPart: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(localPart.trim().toLowerCase()));
  return zBase32Encode(new Uint8Array(digest));
}

export function splitAddress(email: string): { local: string; domain: string } | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 1 || at === normalized.length - 1) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (local.length > 64 || domain.length > 253) return null;
  return { local, domain };
}

export async function wkdDirectUrl(email: string): Promise<string | null> {
  const parts = splitAddress(email);
  if (!parts) return null;
  return `https://${parts.domain}/.well-known/openpgpkey/hu/${await wkdLocalHash(parts.local)}`;
}

export async function wkdAdvancedUrl(email: string): Promise<string | null> {
  const parts = splitAddress(email);
  if (!parts) return null;
  return `https://openpgpkey.${parts.domain}/.well-known/openpgpkey/${parts.domain}/hu/${await wkdLocalHash(parts.local)}`;
}

export type MailboxKeyMaterial = {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A passphrase-encrypted private key. An unlocked key, or a wrong passphrase, is refused. */
export async function importPrivateKey(armored: string, passphrase: string): Promise<MailboxKeyMaterial> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const openpgp = await lib();
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armored });
  if (privateKey.isDecrypted?.() === true) throw new Error("The private key must be protected by a passphrase.");
  await openpgp.decryptKey({ privateKey, passphrase });
  const exported = privateKey.armor();
  const stored = asText(exported).includes("BEGIN PGP PRIVATE KEY BLOCK") ? asText(exported) : armored.trim();
  const publicKey = asText(privateKey.toPublic().armor());
  return { publicKey, privateKey: stored, fingerprint: privateKey.getFingerprint() };
}

export async function importPublicKey(armored: string): Promise<{ publicKey: string; fingerprint: string }> {
  const openpgp = await lib();
  const key = await openpgp.readKey({ armoredKey: armored });
  if (key.isPrivate()) throw new Error("Paste a public key.");
  return { publicKey: asText(key.armor()), fingerprint: key.getFingerprint() };
}

/** Drop a mailbox key the server could use. A locked key is kept. A broken one is dropped. */
export async function acceptMailboxKey(settings: MailSettings): Promise<MailSettings> {
  const key = settings.mailboxKey;
  if (!key) return settings;
  try {
    if (await privateKeyIsLocked(key.privateKey)) return settings;
  } catch {
    /* drop it */
  }
  const next = { ...settings };
  delete next.mailboxKey;
  return next;
}

/** A primary key and up to 15 subkeys: more is not a real mail key, and each one costs an S2K run. */
export const MAX_KEY_PACKETS = 16;

/** True when the armored private key does not open with an empty passphrase. */
export async function privateKeyIsLocked(armored: string): Promise<boolean> {
  const openpgp = await lib();
  let privateKey: Awaited<ReturnType<OpenPgp["readPrivateKey"]>>;
  try {
    privateKey = await openpgp.readPrivateKey({ armoredKey: armored });
  } catch {
    return false;
  }
  if (privateKey.isDecrypted?.() === true) return false;
  // The key comes from the client, and so do its S2K settings. Trying a passphrase runs them: an Argon2
  // S2K can ask for gigabytes and hundreds of passes, per subkey, on every save. So the server never
  // runs Argon2 (a key protected with it is locked by construction: nothing derives from an empty
  // passphrase cheaply), and refuses keys with an unreasonable number of subkeys.
  const packets = [privateKey.keyPacket, ...privateKey.getSubkeys().map((subkey) => subkey.keyPacket)] as Array<{
    s2k?: { type?: string } | null;
    isDecrypted?: () => boolean | null;
  }>;
  if (packets.length > MAX_KEY_PACKETS) return false;
  if (packets.some((packet) => packet.s2k?.type === "argon2")) return packets.every((packet) => packet.isDecrypted?.() !== true);
  try {
    await openpgp.decryptKey({ privateKey, passphrase: "" });
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("already") && message.includes("decrypt")) return false;
    return true;
  }
}

export async function publicKeyBinary(armored: string): Promise<Uint8Array> {
  const openpgp = await lib();
  const key = await openpgp.readKey({ armoredKey: armored });
  return key.toPublic().toPacketList().write();
}

/** Autocrypt header (Level 1). The passphrase is not part of it. */
export async function autocryptHeader(email: string, publicKeyArmored: string, prefer: "mutual" | "nopreference" = "mutual"): Promise<string> {
  const parts = splitAddress(email);
  if (!parts) throw new Error("Autocrypt needs an email address.");
  const binary = await publicKeyBinary(publicKeyArmored);
  const keydata = bytesToBase64(binary);
  const head = `Autocrypt: addr=${parts.local}@${parts.domain}; prefer-encrypt=${prefer}; keydata=`;
  const raw = head + keydata;
  const lines: string[] = [];
  lines.push(raw.slice(0, 78));
  let rest = raw.slice(78);
  while (rest.length) {
    lines.push(` ${rest.slice(0, 77)}`);
    rest = rest.slice(77);
  }
  return lines.join("\r\n");
}

export async function signCleartext(text: string, privateKeyArmored: string, passphrase: string): Promise<string> {
  const openpgp = await lib();
  const privateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
    passphrase,
  });
  const message = await openpgp.createCleartextMessage({ text });
  const signed = await openpgp.sign({ message, signingKeys: privateKey });
  if (typeof signed !== "string") throw new Error("OpenPGP signature did not return text.");
  return signed;
}

export async function verifyCleartext(signed: string, publicKeyArmored: string): Promise<boolean> {
  const openpgp = await lib();
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });
  const verified = await openpgp.verify({ message, verificationKeys: publicKey });
  const signatures = verified.signatures;
  if (!signatures.length) return false;
  try {
    await signatures[0]!.verified;
    return true;
  } catch {
    return false;
  }
}

const BLOCKED_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|.*\.local|.*\.internal|.*\.localhost)$/i;

function publicHttps(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (BLOCKED_HOST.test(parsed.hostname)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)) return false;
    if (parsed.hostname.includes(":")) return false;
    return parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Fetch a recipient's public key from their WKD. Redirects are not followed.
 * A miss or a bad answer is null. The caller does not send the user's private key.
 */
async function resolvesPublic(host: string, resolve: ((host: string) => Promise<string[]>) | null): Promise<boolean> {
  const { assertPublicHost } = await import("./categories.ts");
  try {
    await assertPublicHost(host, resolve);
    return true;
  } catch {
    return false;
  }
}

export async function fetchWkdKey(
  email: string,
  fetcher: typeof fetch = fetch,
  resolve: ((host: string) => Promise<string[]>) | null = null,
): Promise<string | null> {
  const urls = [await wkdAdvancedUrl(email), await wkdDirectUrl(email)].filter((url): url is string => Boolean(url));
  const openpgp = await lib();
  for (const url of urls) {
    if (!publicHttps(url)) continue;
    // The host comes from an address someone typed. On Node, refuse a name that resolves to a private,
    // loopback or metadata address (the same check as one-click unsubscribe); Workers refuse those
    // targets themselves.
    if (!(await resolvesPublic(new URL(url).hostname, resolve))) continue;
    try {
      const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 40 || bytes.byteLength > 64_000) continue;
      const key =
        bytes[0] === 0x2d
          ? await openpgp.readKey({ armoredKey: new TextDecoder().decode(bytes) })
          : await openpgp.readKey({ binaryKey: bytes });
      const armored = asText(key.toPublic().armor());
      if (!armored.includes("BEGIN PGP PUBLIC KEY BLOCK")) continue;
      return armored;
    } catch {
      continue;
    }
  }
  return null;
}
