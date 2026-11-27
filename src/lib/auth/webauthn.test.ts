import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  newChallenge,
  factorOriginFor,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
  type StoredCredential,
} from "./webauthn.ts";

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const buf = Buffer.alloc(3);
  buf[0] = (major << 5) | 25;
  buf.writeUInt16BE(length, 1);
  return buf;
}

const encBytes = (bytes: Buffer) => Buffer.concat([head(2, bytes.length), bytes]);
const encText = (text: string) => Buffer.concat([head(3, Buffer.byteLength(text)), Buffer.from(text)]);
const encUint = (n: number) => head(0, n);
const encNeg = (n: number) => head(1, -1 - n);
const encMap = (pairs: Buffer[]) => Buffer.concat([head(5, pairs.length / 2), ...pairs]);

function cose(x: string, y: string): Buffer {
  return encMap([
    encUint(1),
    encUint(2),
    encUint(3),
    encNeg(-7),
    encNeg(-1),
    encUint(1),
    encNeg(-2),
    encBytes(Buffer.from(x, "base64url")),
    encNeg(-3),
    encBytes(Buffer.from(y, "base64url")),
  ]);
}

function authData(rpId: string, flags: number, counter: number, credId?: Buffer, key?: Buffer): Buffer {
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter);
  const parts: Buffer[] = [createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counterBuf];
  if (credId && key) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    parts.push(Buffer.alloc(16), len, credId, key);
  }
  return Buffer.concat(parts);
}

function client(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

test("a security key registers and then signs in, and a bad origin or a replayed counter does not", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = Buffer.from("credential-id-16b");
  const party = relyingParty("http://localhost:8080", "mail.cumuluscloud.app", {});
  assert.ok(party);
  assert.equal(relyingParty("http://mail.cumuluscloud.app", "mail.cumuluscloud.app"), null);
  // A deployed copy refuses localhost, whichever signal says it is deployed.
  assert.equal(relyingParty("http://localhost:8080", "mail.cumuluscloud.app", { NODE_ENV: "production" }), null);
  assert.equal(relyingParty("http://localhost:8080", "mail.cumuluscloud.app", { BETTER_AUTH_URL: "https://mail.cumuluscloud.app" }), null);
  // The Worker sets neither of those reliably: its committed runtime marker, or a real database, is enough.
  assert.equal(relyingParty("http://localhost:8080", "mail.cumuluscloud.app", { CUMULUS_RUNTIME: "cloudflare" }), null);
  assert.equal(relyingParty("http://localhost:8080", "mail.cumuluscloud.app", { DATABASE_URL: "postgres://db/mail" }), null);
  assert.deepEqual(relyingParty("https://mail.cumuluscloud.app", "mail.cumuluscloud.app", { NODE_ENV: "production" }), {
    origin: "https://mail.cumuluscloud.app",
    rpId: "mail.cumuluscloud.app",
  });
  assert.equal(relyingParty("https://evil.example", "mail.cumuluscloud.app"), null);

  const challenge = newChallenge();
  const created = client("webauthn.create", challenge, party.origin);
  const attested = authData("localhost", 0x41, 0, credId, cose(jwk.x, jwk.y));
  const attestation = encMap([
    encText("fmt"),
    encText("none"),
    encText("attStmt"),
    head(5, 0),
    encText("authData"),
    encBytes(attested),
  ]);
  const registered = verifyRegistration(
    { id: credId.toString("base64url"), clientDataJSON: created.toString("base64url"), attestationObject: attestation.toString("base64url") },
    challenge,
    party,
  );
  const credential: StoredCredential = { ...registered.credential, name: "Key", createdAt: "2026-11-19T00:00:00.000Z" };

  const signIn = (counter: number, origin = party.origin) => {
    const nextChallenge = newChallenge();
    const body = client("webauthn.get", nextChallenge, origin);
    const data = authData("localhost", 0x01, counter);
    const signature = sign("SHA256", Buffer.concat([data, createHash("sha256").update(body).digest()]), privateKey as KeyObject);
    return {
      nextChallenge,
      response: {
        id: credential.id,
        clientDataJSON: body.toString("base64url"),
        authenticatorData: data.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  };

  const first = signIn(1);
  assert.equal(verifyAssertion(first.response, first.nextChallenge, party, credential), 1);
  const replay = signIn(1);
  assert.throws(() => verifyAssertion(replay.response, replay.nextChallenge, party, { ...credential, counter: 1 }), /counter/);
  const wrong = signIn(2, "https://evil.example");
  assert.throws(() => verifyAssertion(wrong.response, wrong.nextChallenge, party, { ...credential, counter: 1 }), /origin/);
});

test("a deployed copy checks security keys against its own host, whatever the request headers say", () => {
  const forged = {
    url: "http://internal:3000/_serverFn/x",
    headers: new Headers({ host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
  };
  for (const env of [{ NODE_ENV: "production" }, { CUMULUS_RUNTIME: "cloudflare" }, { DATABASE_URL: "postgres://db/mail" }, { BETTER_AUTH_URL: "https://mail.cumuluscloud.app" }]) {
    assert.equal(factorOriginFor("mail.cumuluscloud.app", forged, env), "https://mail.cumuluscloud.app");
  }
  assert.equal(factorOriginFor("mail.cumuluscloud.app", undefined, {}), "https://mail.cumuluscloud.app");
  // A local copy follows the request, so http://localhost development works.
  const local = { url: "http://localhost:8080/_serverFn/x", headers: new Headers({ host: "localhost:8080" }) };
  assert.equal(factorOriginFor("mail.cumuluscloud.app", local, {}), "http://localhost:8080");
});
