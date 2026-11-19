import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClientIndex, generateHybrid, isHybrid, openHybridSecrets, openHybridText, sealHybridText, searchClientIndex, indexKey } from "./pqc.ts";

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
