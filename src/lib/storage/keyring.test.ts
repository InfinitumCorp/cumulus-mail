import assert from "node:assert/strict";
import { test } from "node:test";
import { seal } from "./crypto.ts";
import { blindKeyFromEnv, keyringFromEnv, openWith, resealed, sealedKeyId, sealWith } from "./keyring.ts";

const K0 = "00".repeat(32);
const K1 = "11".repeat(32);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

test("without MAIL_BLOB_KEYS, MAIL_BLOB_KEY alone is key 0 and current", () => {
  const ring = keyringFromEnv({ MAIL_BLOB_KEY: K0 });
  assert.equal(ring.current, 0);
  assert.deepEqual([...ring.keys.keys()], [0]);
});

test("MAIL_BLOB_KEYS: first is current, the rest decrypt only; bad lists are refused", () => {
  const ring = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},0:${K0}` });
  assert.equal(ring.current, 1);
  assert.deepEqual([...ring.keys.keys()].sort(), [0, 1]);
  assert.throws(() => keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},1:${K0}` }), /twice/);
  assert.throws(() => keyringFromEnv({ MAIL_BLOB_KEYS: "1:short" }), /32 bytes/);
  assert.throws(() => keyringFromEnv({ MAIL_BLOB_KEYS: K1 }), /<id>:<key>/);
});

test("mixed-key data reads correctly: today's v1 values and new v2 values side by side", () => {
  const ring = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},0:${K0}` });
  const legacy = seal(Buffer.from(K0, "hex"), "tenant-a", bytes("stored today"), "meta"); // v1, key 0
  const fresh = sealWith(ring, "tenant-a", bytes("stored after rotation"), "meta");
  assert.equal(sealedKeyId(legacy), 0);
  assert.equal(sealedKeyId(fresh), 1);
  assert.equal(text(openWith(ring, "tenant-a", legacy, "meta")), "stored today");
  assert.equal(text(openWith(ring, "tenant-a", fresh, "meta")), "stored after rotation");
});

test("the key id is authenticated: relabelling a value with another id fails", () => {
  const ring = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},0:${K0}` });
  const sealed = sealWith(ring, "tenant-a", bytes("x"));
  const forged = new Uint8Array(sealed);
  forged[1] = 0;
  assert.throws(() => openWith(ring, "tenant-a", forged));
});

test("re-keying is idempotent: a value already under the current key is left alone", () => {
  const ring = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},0:${K0}` });
  const legacy = seal(Buffer.from(K0, "hex"), "tenant-a", bytes("mail"));
  const once = resealed(ring, "tenant-a", legacy);
  assert.ok(once);
  assert.equal(sealedKeyId(once!), 1);
  assert.equal(resealed(ring, "tenant-a", once!), null, "a second run changes nothing");
  assert.equal(text(openWith(ring, "tenant-a", once!)), "mail");
});

test("after the old key is removed, values still under it are unreadable; re-keyed ones read fine", () => {
  const both = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1},0:${K0}` });
  const legacy = seal(Buffer.from(K0, "hex"), "tenant-a", bytes("never re-keyed"));
  const rekeyed = resealed(both, "tenant-a", seal(Buffer.from(K0, "hex"), "tenant-a", bytes("re-keyed")))!;
  const newOnly = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${K1}` });
  assert.throws(() => openWith(newOnly, "tenant-a", legacy), /key 0, which is not in MAIL_BLOB_KEYS/);
  assert.equal(text(openWith(newOnly, "tenant-a", rekeyed)), "re-keyed");
});

test("blind indexes stay on a stable key that does not rotate with MAIL_BLOB_KEYS", () => {
  assert.deepEqual(blindKeyFromEnv({ MAIL_BLOB_KEY: K0, MAIL_BLOB_KEYS: `1:${K1},0:${K0}` }), new Uint8Array(Buffer.from(K0, "hex")));
  assert.deepEqual(blindKeyFromEnv({ MAIL_BLIND_KEY: K1, MAIL_BLOB_KEY: K0 }), new Uint8Array(Buffer.from(K1, "hex")));
});
