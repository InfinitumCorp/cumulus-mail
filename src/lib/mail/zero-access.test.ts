import assert from "node:assert/strict";
import { test } from "node:test";
import { totpCode } from "../auth/totp.ts";
import { decryptWith, generateMailKey } from "./openpgp.ts";
import { beginTotp, confirmTotp, factorBlocks, verifyTotp } from "./factors.ts";
import { ingestInboundEmail } from "./inbound.ts";
import { openMailbox } from "./mailbox.ts";
import { blockSender, inboundVerdict } from "./spam.ts";
import { readMessages, readSettings, writeSettings } from "./records.ts";
import { defaultSettings } from "./settings.ts";
import { createHarness, profile } from "./test-support.ts";
import { wkdDirectKey, wkdResponse } from "./wkd.ts";
import { wkdLocalHash } from "./pgp-keys.ts";
import type { MailAuth } from "./model.ts";

const PASS: MailAuth = { spf: "pass", dkim: "pass", dmarc: "pass", policy: "none", disposition: "deliver" };

test("an authenticator locks the mailbox until a code or a recovery code, and a code works once", async () => {
  const harness = await createHarness();
  try {
    const tenant = "factor-ada";
    await openMailbox(harness.db, tenant, profile(tenant, "ada.factor@cumuluscloud.app", "Ada"));
    assert.equal(await factorBlocks(harness.db, tenant), false);
    const begun = await beginTotp(harness.db, tenant, "ada.factor@cumuluscloud.app");
    await assert.rejects(() => confirmTotp(harness.db, tenant, "000000"), /not valid/);
    const confirmed = await confirmTotp(harness.db, tenant, totpCode(begun.secret));
    assert.equal(confirmed.recoveryCodes.length, 8);
    assert.equal(await factorBlocks(harness.db, tenant), false);
    await harness.db.query(`update cumulus_mail.second_factors set satisfied_until = '2000-01-01T00:00:00.000Z' where tenant_id = $1`, [tenant]);
    assert.equal(await factorBlocks(harness.db, tenant), true);
    await verifyTotp(harness.db, tenant, confirmed.recoveryCodes[0]!);
    assert.equal(await factorBlocks(harness.db, tenant), false);
    await harness.db.query(`update cumulus_mail.second_factors set satisfied_until = '2000-01-01T00:00:00.000Z' where tenant_id = $1`, [tenant]);
    await assert.rejects(() => verifyTotp(harness.db, tenant, confirmed.recoveryCodes[0]!), /not valid/);
  } finally {
    await harness.close();
  }
});

test("a published key seals inbound mail and is served on WKD, and block does not vote", async () => {
  const harness = await createHarness();
  try {
    const tenant = "seal-ada";
    const email = "ada.seal@cumuluscloud.app";
    await openMailbox(harness.db, tenant, profile(tenant, email, "Ada"));
    const key = await generateMailKey("Ada", email, "passphrase-ada");
    await writeSettings(harness.db, tenant, {
      ...defaultSettings(),
      mailboxKey: { publicKey: key.publicKey, privateKey: key.privateKey, fingerprint: "" },
    });
    const stored = await readSettings(harness.db, tenant);
    assert.equal(stored.mailboxKey?.publicKey.includes("BEGIN PGP PUBLIC KEY BLOCK"), true);
    assert.equal(JSON.stringify(stored).includes("passphrase-ada"), false);
    const hash = await wkdLocalHash("ada.seal");
    const served = await wkdResponse(harness.db, `/.well-known/openpgpkey/hu/${hash}`);
    assert.equal(served?.status, 200);
    const bytes = new Uint8Array(await served!.arrayBuffer());
    assert.equal(bytes.byteLength > 40, true);
    assert.equal(await wkdDirectKey(harness.db, "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"), null);

    const raw = [
      "From: Mira <mira@example.com>",
      `To: Ada <${email}>`,
      "Subject: Notes",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello from outside.",
      "",
    ].join("\r\n");
    await ingestInboundEmail(harness.db, harness.storageFor, { from: "mira@example.com", to: email, raw: new TextEncoder().encode(raw) });
    const [message] = await readMessages(harness.db, tenant);
    assert.equal(message?.body.includes("Hello from outside."), false);
    assert.equal(message?.extra?.zeroAccess, true);
    assert.equal(await decryptWith(message!.body, key.privateKey, "passphrase-ada"), "Hello from outside.");

    await blockSender(harness.db, tenant, "mira@example.com");
    assert.equal((await inboundVerdict(harness.db, tenant, "mira@example.com", PASS)).reason, "blocklisted");
    const votes = await harness.db.query<{ n: string }>(`select count(*) as n from cumulus_mail.spam_votes`);
    assert.equal(Number(votes[0]?.n ?? 0), 0);
  } finally {
    await harness.close();
  }
});
