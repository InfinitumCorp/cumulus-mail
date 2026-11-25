import assert from "node:assert/strict";
import { test } from "node:test";
import { totpCode } from "../auth/totp.ts";
import { decryptWith, generateMailKey } from "./openpgp.ts";
import { beginTotp, confirmTotp, factorBlocks, factorSessionKey, factorStatus, MAX_FAILURES, UNLOCK_ACTIONS, verifyTotp } from "./factors.ts";
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
    const phone = await factorSessionKey("session:phone");
    await openMailbox(harness.db, tenant, profile(tenant, "ada.factor@cumuluscloud.app", "Ada"));
    assert.equal(await factorBlocks(harness.db, tenant, phone), false);
    const begun = await beginTotp(harness.db, tenant, "ada.factor@cumuluscloud.app");
    await assert.rejects(() => confirmTotp(harness.db, tenant, "000000", phone), /not valid/);
    const confirmed = await confirmTotp(harness.db, tenant, totpCode(begun.secret), phone);
    assert.equal(confirmed.recoveryCodes.length, 8);
    assert.equal(await factorBlocks(harness.db, tenant, phone), false);
    await harness.db.query(`update cumulus_mail.second_factors set satisfied_sessions = '[]' where tenant_id = $1`, [tenant]);
    assert.equal(await factorBlocks(harness.db, tenant, phone), true);
    await verifyTotp(harness.db, tenant, confirmed.recoveryCodes[0]!, phone);
    assert.equal(await factorBlocks(harness.db, tenant, phone), false);
    await harness.db.query(`update cumulus_mail.second_factors set satisfied_sessions = '[]' where tenant_id = $1`, [tenant]);
    await assert.rejects(() => verifyTotp(harness.db, tenant, confirmed.recoveryCodes[0]!, phone), /not valid/);
  } finally {
    await harness.close();
  }
});

test("a pass opens only the session that earned it; a stolen session stays locked", async () => {
  const harness = await createHarness();
  try {
    const tenant = "factor-bea";
    const owner = await factorSessionKey("session:owner-laptop");
    const thief = await factorSessionKey("session:stolen-cookie");
    await openMailbox(harness.db, tenant, profile(tenant, "bea.factor@cumuluscloud.app", "Bea"));
    const begun = await beginTotp(harness.db, tenant, "bea.factor@cumuluscloud.app");
    await confirmTotp(harness.db, tenant, totpCode(begun.secret, Date.now() - 30_000), owner);
    assert.equal(await factorBlocks(harness.db, tenant, owner), false, "the owner passed");
    assert.equal(await factorBlocks(harness.db, tenant, thief), true, "another session did not");
    assert.equal((await factorStatus(harness.db, tenant, thief)).satisfied, false);
    // The gate lets a locked session check in, and nothing else: no enrolling, no removing.
    for (const action of ["status", "totp-verify", "webauthn-assert-options", "webauthn-assert"]) assert.equal(UNLOCK_ACTIONS.has(action), true, action);
    for (const action of ["totp-begin", "totp-confirm", "totp-disable", "webauthn-register-options", "webauthn-register", "webauthn-remove"]) {
      assert.equal(UNLOCK_ACTIONS.has(action), false, action);
    }
  } finally {
    await harness.close();
  }
});

test("a TOTP code is accepted once, a recovery code is spent once under a race, and failures are throttled", async () => {
  const harness = await createHarness();
  try {
    const tenant = "factor-cy";
    const one = await factorSessionKey("session:one");
    const two = await factorSessionKey("session:two");
    await openMailbox(harness.db, tenant, profile(tenant, "cy.factor@cumuluscloud.app", "Cy"));
    const begun = await beginTotp(harness.db, tenant, "cy.factor@cumuluscloud.app");
    const { recoveryCodes } = await confirmTotp(harness.db, tenant, totpCode(begun.secret, Date.now() - 30_000), one);
    const now = totpCode(begun.secret);
    await verifyTotp(harness.db, tenant, now, one);
    await assert.rejects(() => verifyTotp(harness.db, tenant, now, two), /already used/, "the same code from another session");
    assert.equal(await factorBlocks(harness.db, tenant, two), true);

    const results = await Promise.allSettled([
      verifyTotp(harness.db, tenant, recoveryCodes[1]!, two),
      verifyTotp(harness.db, tenant, recoveryCodes[1]!, two),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1, "one of two racing uses wins");

    const throttled = "factor-dee";
    const key = await factorSessionKey("session:dee");
    await openMailbox(harness.db, throttled, profile(throttled, "dee.factor@cumuluscloud.app", "Dee"));
    const dee = await beginTotp(harness.db, throttled, "dee.factor@cumuluscloud.app");
    await confirmTotp(harness.db, throttled, totpCode(dee.secret, Date.now() - 30_000), key);
    for (let i = 0; i < MAX_FAILURES; i += 1) await assert.rejects(() => verifyTotp(harness.db, throttled, "000000", key), /not valid/);
    await assert.rejects(() => verifyTotp(harness.db, throttled, totpCode(dee.secret), key), /Too many tries/, "even a right code waits");
  } finally {
    await harness.close();
  }
});

test("before migration 0022 is applied, the factor still works with one window per mailbox", async () => {
  const harness = await createHarness();
  try {
    for (const column of ["satisfied_sessions", "totp_last_step", "failures", "failures_since"]) {
      await harness.db.query(`alter table cumulus_mail.second_factors drop column ${column}`);
    }
    const tenant = "factor-old";
    const session = await factorSessionKey("session:old");
    await openMailbox(harness.db, tenant, profile(tenant, "old.factor@cumuluscloud.app", "Old"));
    const begun = await beginTotp(harness.db, tenant, "old.factor@cumuluscloud.app");
    const { recoveryCodes } = await confirmTotp(harness.db, tenant, totpCode(begun.secret), session);
    assert.equal(await factorBlocks(harness.db, tenant, session), false);
    await harness.db.query(`update cumulus_mail.second_factors set satisfied_until = '2000-01-01T00:00:00.000Z' where tenant_id = $1`, [tenant]);
    assert.equal(await factorBlocks(harness.db, tenant, session), true);
    await verifyTotp(harness.db, tenant, recoveryCodes[0]!, session);
    assert.equal(await factorBlocks(harness.db, tenant, session), false);
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
