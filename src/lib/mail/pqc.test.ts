import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSettings } from "./settings.ts";
import { buildClientIndex, upgradeHybridWrap, generateHybrid, isHybrid, openHybridSecrets, openHybridText, sealHybridText, searchClientIndex, indexKey } from "./pqc.ts";

test("hybrid encryption needs both secrets and does not contain the plaintext", async () => {
  const ada = await generateHybrid("passphrase-ada");
  const sealed = await sealHybridText("security appendix", ada);
  assert.equal(isHybrid(sealed), true);
  assert.equal(sealed.includes("security appendix"), false);
  assert.equal(sealed.includes(ada.wrappedSecrets), false);
  const secrets = await openHybridSecrets(ada.wrappedSecrets, "passphrase-ada");
  assert.equal(await openHybridText(sealed, secrets, ada.x25519Public), "security appendix");
  await assert.rejects(() => openHybridSecrets(ada.wrappedSecrets, "wrong-passphrase-here"), /operation|decrypt|key/i);
  const other = await generateHybrid("passphrase-bea");
  const otherSecrets = await openHybridSecrets(other.wrappedSecrets, "passphrase-bea");
  await assert.rejects(() => openHybridText(sealed, otherSecrets, other.x25519Public));
});

test("a client-held index matches on another device with the same passphrase and hides the words", async () => {
  const salt = new Uint8Array(16).fill(7);
  const key = await indexKey("passphrase-ada", salt);
  const again = await indexKey("passphrase-ada", salt);
  assert.deepEqual([...key], [...again]);
  const index = await buildClientIndex([{ id: "m1", subject: "Budget appendix", body: "private numbers" }], key);
  assert.equal(JSON.stringify(index).includes("budget"), false);
  assert.deepEqual(await searchClientIndex(index, again, "budget appendix"), ["m1"]);
  assert.deepEqual(await searchClientIndex(index, await indexKey("other-passphrase", salt), "budget"), []);
});

test("new passphrase wraps keep the plain format every build reads, and older wraps still open", async () => {
  const ada = await generateHybrid("passphrase-ada");
  // The pattern a build from before #200 accepts (settings.ts b64url): no prefix, so a rollback keeps the key.
  assert.match(ada.wrappedSecrets, /^[A-Za-z0-9_-]+$/);
  const secrets = await openHybridSecrets(ada.wrappedSecrets, "passphrase-ada");

  // Re-wrap the same secrets the way builds before the version prefix did: PBKDF2 at 100,000 rounds, no prefix.
  const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const packed = Buffer.from(ada.wrappedSecrets, "base64url");
  const plain = await (async () => {
    const salt = packed.subarray(0, 16);
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("passphrase-ada"), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, base, 256);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
    const mixed = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("cumulus-mail-pq-wrap-v1") }, hk, 256);
    const key = await crypto.subtle.importKey("raw", mixed, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(16, 28) }, key, packed.subarray(28)));
  })();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("passphrase-ada"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, base, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  const mixed = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("cumulus-mail-pq-wrap-v1") }, hk, 256);
  const key = await crypto.subtle.importKey("raw", mixed, "AES-GCM", false, ["encrypt"]);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const legacy = b64u(Buffer.concat([salt, iv, box]));

  const reopened = await openHybridSecrets(legacy, "passphrase-ada");
  assert.deepEqual(reopened, secrets);
  await assert.rejects(() => openHybridSecrets(legacy, "wrong-passphrase-here"));
  // "w2." values (written by #200 for a while) still open, at the current rounds only.
  const prefixed = "w2." + ada.wrappedSecrets;
  assert.deepEqual(await openHybridSecrets(prefixed, "passphrase-ada"), secrets);
  await assert.rejects(() => openHybridSecrets("w2." + legacy, "passphrase-ada"));

  // Unlocking re-wraps an old or prefixed key once, into the plain current form; a current one is left alone.
  const upgraded = await upgradeHybridWrap(legacy, "passphrase-ada");
  assert.match(upgraded ?? "", /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await openHybridSecrets(upgraded!, "passphrase-ada"), secrets);
  assert.equal(await upgradeHybridWrap(upgraded!, "passphrase-ada"), undefined);
  assert.equal(await upgradeHybridWrap(ada.wrappedSecrets, "passphrase-ada"), undefined);
  const unprefixed = await upgradeHybridWrap(prefixed, "passphrase-ada");
  assert.match(unprefixed ?? "", /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await openHybridSecrets(unprefixed!, "passphrase-ada"), secrets);
  await assert.rejects(() => upgradeHybridWrap(legacy, "wrong-passphrase-here"));

  // Both forms survive a settings save unchanged; anything else after the prefix is dropped.
  const keep = (wrappedSecrets: string) =>
    sanitizeSettings({
      mailboxKey: {
        publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----",
        privateKey: "-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----",
        hybrid: { x25519Public: ada.x25519Public, mlkemPublic: ada.mlkemPublic, wrappedSecrets },
      },
    }).mailboxKey?.hybrid?.wrappedSecrets;
  assert.equal(keep(ada.wrappedSecrets), ada.wrappedSecrets);
  assert.equal(keep(legacy), legacy);
  assert.equal(keep(prefixed), prefixed);
  assert.equal(keep("w2.not base64!"), undefined);
});
