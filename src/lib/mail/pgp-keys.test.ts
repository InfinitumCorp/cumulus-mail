import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateMailKey } from "./openpgp.ts";
import {
  acceptMailboxKey,
  autocryptHeader,
  fetchWkdKey,
  importPrivateKey,
  privateKeyIsLocked,
  publicKeyBinary,
  signCleartext,
  verifyCleartext,
  wkdLocalHash,
  zBase32Encode,
} from "./pgp-keys.ts";
import { defaultSettings } from "./settings.ts";
import { safeAutocryptHeader } from "./outbound/message.ts";

test("z-base32 and the WKD local-part hash are stable", async () => {
  assert.equal(zBase32Encode(new Uint8Array([0])), "yy");
  const sha = createHash("sha1").update("joe.doe").digest();
  assert.equal(await wkdLocalHash("Joe.Doe"), zBase32Encode(sha));
  assert.equal((await wkdLocalHash("Joe.Doe")).length, 32);
});

test("a mailbox key stays locked, signs, and publishes an Autocrypt header without the private key", async () => {
  const ada = await generateMailKey("Ada", "ada@cumuluscloud.app", "passphrase-ada");
  assert.equal(await privateKeyIsLocked(ada.privateKey), true);
  await assert.rejects(() => importPrivateKey(ada.privateKey, "wrong-pass"), /passphrase|decrypt|key/i);
  const imported = await importPrivateKey(ada.privateKey, "passphrase-ada");
  assert.equal(imported.fingerprint, (await importPrivateKey(ada.privateKey, "passphrase-ada")).fingerprint);
  assert.equal(imported.publicKey.includes("BEGIN PGP PUBLIC KEY BLOCK"), true);
  const dropped = await acceptMailboxKey({
    ...defaultSettings(),
    mailboxKey: { publicKey: ada.publicKey, privateKey: "-----BEGIN PGP PRIVATE KEY BLOCK-----\nnot a key\n-----END PGP PRIVATE KEY BLOCK-----", fingerprint: "" },
  });
  assert.equal(dropped.mailboxKey, undefined);
  const signed = await signCleartext("security appendix", ada.privateKey, "passphrase-ada");
  assert.equal(await verifyCleartext(signed, ada.publicKey), true);
  assert.equal(await verifyCleartext(signed.replace("appendix", "changed!"), ada.publicKey), false);
  const header = await autocryptHeader("ada@cumuluscloud.app", ada.publicKey);
  assert.equal(safeAutocryptHeader(header), true);
  assert.equal(header.includes(ada.privateKey), false);
  assert.equal(header.includes("BEGIN PGP"), false);
  assert.equal(safeAutocryptHeader("Autocrypt: addr=ada@cumuluscloud.app\r\nBcc: evil@example.com"), false);
  const binary = await publicKeyBinary(ada.publicKey);
  const publicDns = async () => ["93.184.216.34"];
  const fetched = await fetchWkdKey("ada@example.com", async () => new Response(Buffer.from(binary)), publicDns);
  assert.equal(fetched?.includes("BEGIN PGP PUBLIC KEY BLOCK"), true);
  const missed = await fetchWkdKey("ada@example.com", async () => new Response("no", { status: 404 }), publicDns);
  assert.equal(missed, null);
  // A domain that resolves to a private or metadata address is never fetched.
  const asked: string[] = [];
  const watch = (async (url: string) => {
    asked.push(url);
    return new Response(Buffer.from(binary));
  }) as unknown as typeof fetch;
  assert.equal(await fetchWkdKey("ada@rebind.example", watch, async () => ["169.254.169.254"]), null);
  assert.deepEqual(asked, []);
});

test("an uploaded key's S2K settings are never run when they could be expensive", async () => {
  const openpgp = await import("openpgp");
  const { privateKey } = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ email: "argon@cumuluscloud.app" }],
    passphrase: "passphrase-argon",
    config: { s2kType: openpgp.enums.s2k.argon2, aeadProtect: true, s2kArgon2Params: { passes: 1, parallelism: 1, memoryExponent: 10 } },
  });
  // Argon2: locked by construction, and decryptKey is not called.
  const started = Date.now();
  assert.equal(await privateKeyIsLocked(privateKey), true);
  assert.ok(Date.now() - started < 5_000);

  const { MAX_KEY_PACKETS } = await import("./pgp-keys.ts");
  const many = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ email: "many@cumuluscloud.app" }],
    passphrase: "passphrase-many",
    subkeys: Array.from({ length: MAX_KEY_PACKETS }, () => ({})),
  });
  assert.equal(await privateKeyIsLocked(many.privateKey), false, "too many subkeys: refused like an open key");
});
