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
  const fetched = await fetchWkdKey("ada@example.com", async () => new Response(Buffer.from(binary)));
  assert.equal(fetched?.includes("BEGIN PGP PUBLIC KEY BLOCK"), true);
  const missed = await fetchWkdKey("ada@example.com", async () => new Response("no", { status: 404 }));
  assert.equal(missed, null);
});
