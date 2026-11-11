import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import type { ProtectedEnvelope } from "./model.ts";

export const PROTECTED_PLACEHOLDER = "This message is password-protected.";

const DEFAULT_ITERATIONS = 20_000;

function view(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: view(salt), iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealWithPassword(
  body: string,
  password: string,
  options: { expiresAt: string; reads: number; selfDestruct: boolean; iterations?: number },
): Promise<ProtectedEnvelope> {
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: view(iv) }, key, new TextEncoder().encode(body));
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
    expiresAt: options.expiresAt,
    readsLeft: Math.max(1, Math.min(100, Math.trunc(options.reads))),
    selfDestruct: options.selfDestruct,
    iterations,
  };
}

export function envelopeBlock(envelope: ProtectedEnvelope, now = Date.now()): string | null {
  const expires = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return "This password-protected message has expired.";
  if (envelope.readsLeft <= 0 || !envelope.ciphertext) return "This password-protected message has already been opened.";
  return null;
}

export async function openWithPassword(envelope: ProtectedEnvelope, password: string, now = Date.now()): Promise<string> {
  const blocked = envelopeBlock(envelope, now);
  if (blocked) throw new Error(blocked);
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const key = await deriveKey(password, salt, envelope.iterations);
  try {
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: view(iv) }, key, view(base64ToBytes(envelope.ciphertext)));
    return new TextDecoder().decode(clear);
  } catch {
    throw new Error("That password does not open this message.");
  }
}

/** One successful open. Self-destruct wipes the ciphertext. */
export function spendRead(envelope: ProtectedEnvelope): ProtectedEnvelope {
  const readsLeft = Math.max(0, envelope.readsLeft - 1);
  if (envelope.selfDestruct || readsLeft === 0) {
    return { ...envelope, readsLeft: 0, ciphertext: "", salt: "", iv: "" };
  }
  return { ...envelope, readsLeft };
}
