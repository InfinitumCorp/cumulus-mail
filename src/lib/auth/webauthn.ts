import { createHash, createPublicKey, createVerify, randomBytes, verify as verifyEd } from "node:crypto";

export type RelyingParty = { origin: string; rpId: string };

/**
 * https on the mail host. localhost over http only on a copy that is not deployed (no BETTER_AUTH_URL and
 * NODE_ENV not production, the same test as authRateLimit): a deployed server must never accept a key
 * registered for, or an assertion made on, a page served from someone's own machine. Anything else is refused.
 */
export function relyingParty(
  origin: string,
  appHost: string,
  env: Record<string, string | undefined> = process.env,
): RelyingParty | null {
  const deployed = Boolean(env.BETTER_AUTH_URL?.trim()) || env.NODE_ENV === "production";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" && url.protocol === "http:") return deployed ? null : { origin: url.origin, rpId: "localhost" };
  if (url.protocol !== "https:") return null;
  if (host !== appHost.toLowerCase()) return null;
  return { origin: url.origin, rpId: host };
}

export function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export type StoredCredential = {
  id: string;
  publicKeyJwk: JsonWebKey;
  alg: "ES256" | "Ed25519";
  counter: number;
  name: string;
  createdAt: string;
};

export type RegistrationResponse = {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
};

export type AssertionResponse = {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

type ClientData = { type?: string; challenge?: string; origin?: string };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 20_000) throw new Error("Bad webauthn encoding");
  return Buffer.from(value, "base64url");
}

function readInfo(data: Uint8Array, offset: number, info: number): { length: number; offset: number } {
  if (info < 24) return { length: info, offset };
  const sizes = [1, 2, 4, 8];
  const size = sizes[info - 24];
  if (!size || offset + size > data.length) throw new Error("Truncated CBOR");
  let length = 0;
  for (let i = 0; i < size; i += 1) length = length * 256 + data[offset + i]!;
  if (length > data.length) throw new Error("CBOR length too large");
  return { length, offset: offset + size };
}

/** Enough CBOR for a WebAuthn attestation object and a COSE key. */
export function cborDecode(data: Uint8Array, start = 0): { value: unknown; offset: number } {
  if (start >= data.length) throw new Error("Truncated CBOR");
  const initial = data[start]!;
  const major = initial >> 5;
  const info = initial & 31;
  if (info > 27) throw new Error("Unsupported CBOR");
  const { length, offset } = readInfo(data, start + 1, info);
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) {
    if (offset + length > data.length) throw new Error("Truncated CBOR bytes");
    return { value: data.slice(offset, offset + length), offset: offset + length };
  }
  if (major === 3) {
    if (offset + length > data.length) throw new Error("Truncated CBOR text");
    return { value: new TextDecoder().decode(data.slice(offset, offset + length)), offset: offset + length };
  }
  if (major === 4) {
    const items: unknown[] = [];
    let cursor = offset;
    for (let i = 0; i < length; i += 1) {
      const next = cborDecode(data, cursor);
      items.push(next.value);
      cursor = next.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    let cursor = offset;
    for (let i = 0; i < length; i += 1) {
      const key = cborDecode(data, cursor);
      const val = cborDecode(data, key.offset);
      map.set(key.value, val.value);
      cursor = val.offset;
    }
    return { value: map, offset: cursor };
  }
  if (major === 7 && info === 20) return { value: false, offset: start + 1 };
  if (major === 7 && info === 21) return { value: true, offset: start + 1 };
  if (major === 7 && info === 22) return { value: null, offset: start + 1 };
  throw new Error("Unsupported CBOR");
}

function mapGet(map: Map<unknown, unknown>, key: unknown): unknown {
  for (const [candidate, value] of map) if (candidate === key) return value;
  return undefined;
}

function clientData(encoded: string, expectedType: string, challenge: string, party: RelyingParty): void {
  const parsed = JSON.parse(fromB64(encoded).toString("utf8")) as ClientData;
  if (parsed.type !== expectedType) throw new Error("Unexpected WebAuthn type");
  if (parsed.challenge !== challenge) throw new Error("WebAuthn challenge does not match");
  if (parsed.origin !== party.origin) throw new Error("WebAuthn origin does not match");
}

function counterOf(authData: Uint8Array): number {
  if (authData.length < 37) throw new Error("Authenticator data is too short");
  // Unsigned: `<< 24` alone turns a counter of 2^31 or more negative, and the regression check fails open.
  return ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0;
}

function rpMatches(authData: Uint8Array, rpId: string): void {
  const hash = createHash("sha256").update(rpId).digest();
  if (!hash.equals(authData.subarray(0, 32))) throw new Error("WebAuthn rpId does not match");
  if ((authData[32]! & 0x01) === 0) throw new Error("WebAuthn user presence is required");
}

type ParsedKey = { jwk: JsonWebKey; alg: "ES256" | "Ed25519" };

function coseToJwk(cose: Uint8Array): ParsedKey {
  const decoded = cborDecode(cose);
  if (!(decoded.value instanceof Map)) throw new Error("COSE key is not a map");
  const map = decoded.value;
  const kty = mapGet(map, 1);
  const alg = mapGet(map, 3);
  const crv = mapGet(map, -1);
  const x = mapGet(map, -2);
  const y = mapGet(map, -3);
  if (!(x instanceof Uint8Array)) throw new Error("COSE key is missing x");
  if (kty === 2 && alg === -7 && crv === 1 && y instanceof Uint8Array) {
    return { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) } };
  }
  if (kty === 1 && alg === -8 && crv === 6) {
    return { alg: "Ed25519", jwk: { kty: "OKP", crv: "Ed25519", x: b64url(x) } };
  }
  throw new Error("Only ES256 and Ed25519 security keys are accepted");
}

function checkSignature(alg: "ES256" | "Ed25519", jwk: JsonWebKey, data: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({ key: jwk as import("node:crypto").JsonWebKey, format: "jwk" });
  if (alg === "Ed25519") return verifyEd(null, data, key, signature);
  const verifier = createVerify("SHA256");
  verifier.update(data);
  verifier.end();
  return verifier.verify(key, signature);
}

/**
 * Accept a registration. Attestation certificates are not required: the signed-in
 * person is enrolling their own key, and a later assertion proves they hold it.
 */
export function verifyRegistration(
  response: RegistrationResponse,
  challenge: string,
  party: RelyingParty,
): { id: string; credential: Omit<StoredCredential, "name" | "createdAt"> } {
  clientData(response.clientDataJSON, "webauthn.create", challenge, party);
  const attestation = cborDecode(fromB64(response.attestationObject));
  if (!(attestation.value instanceof Map)) throw new Error("Bad attestation");
  const authData = mapGet(attestation.value, "authData");
  if (!(authData instanceof Uint8Array)) throw new Error("Attestation has no authData");
  rpMatches(authData, party.rpId);
  if ((authData[32]! & 0x40) === 0) throw new Error("Registration did not include a credential");
  const idLength = (authData[53]! << 8) | authData[54]!;
  if (idLength < 1 || 55 + idLength > authData.length) throw new Error("Bad credential id");
  const id = b64url(authData.subarray(55, 55 + idLength));
  if (id !== response.id) throw new Error("Credential id does not match");
  const parsed = coseToJwk(authData.subarray(55 + idLength));
  return { id, credential: { id, publicKeyJwk: parsed.jwk, alg: parsed.alg, counter: counterOf(authData) } };
}

/** Accept an assertion and return the new signature counter. */
export function verifyAssertion(
  response: AssertionResponse,
  challenge: string,
  party: RelyingParty,
  credential: StoredCredential,
): number {
  if (response.id !== credential.id) throw new Error("Unknown security key");
  clientData(response.clientDataJSON, "webauthn.get", challenge, party);
  const authData = fromB64(response.authenticatorData);
  rpMatches(authData, party.rpId);
  const next = counterOf(authData);
  if (credential.counter > 0 && next <= credential.counter) throw new Error("Security key counter went backwards");
  const clientHash = createHash("sha256").update(fromB64(response.clientDataJSON)).digest();
  const signed = Buffer.concat([authData, clientHash]);
  const signature = fromB64(response.signature);
  if (!checkSignature(credential.alg, credential.publicKeyJwk, signed, signature)) throw new Error("Security key signature is not valid");
  return next === 0 ? credential.counter : next;
}
