import { SIGN_IN_ISSUER } from "./identity.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeDesign } from "./bridge.ts";
import { isDriveShareHref, stubCloudLinks } from "./cloud-link.ts";
import { refreshDomainVerification } from "./domains.ts";
import { findTenantByAddress } from "./directory.ts";
import { identityPosture } from "./identity.ts";
import { parseInvite } from "./invite.ts";
import { listThreads } from "./logic.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import { SEED_MESSAGES, type MailMessage } from "./model.ts";
import { decryptWith, encryptFor, generateMailKey } from "./openpgp.ts";
import { openWithPassword, sealWithPassword, spendRead } from "./protect.ts";
import { burnProtectedLink, issueProtectedLink, readProtectedLink } from "./protect-store.ts";
import { readMessages, readSettings, readSnapshot, writeSettings } from "./records.ts";
import { releaseDue, sanitizeExtra } from "./schedule.ts";
import { assessPhishing, classifyLink, stripRemoteImages } from "./safety.ts";
import { buildSearchIndex, indexContainsPlaintext, queryIndex } from "./search-index.ts";
import { defaultSettings, expectedTxt, keepVerified, TXT_VALUE } from "./settings.ts";
import { applySieve, parseSieve } from "./sieve.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import { createHarness, profile } from "./test-support.ts";

const fast = { expiresAt: "2099-01-01T00:00:00.000Z", reads: 2, selfDestruct: false, iterations: 1000 };

test("large-file links point at Cumulus://Cloud Drive", async () => {
  const link = await stubCloudLinks(Date.parse("2026-11-10T00:00:00.000Z")).create({ name: "brief.pdf", size: 30_000_000 }, 60_000);
  assert.equal(link.href.startsWith("https://drive.cumuluscloud.app/s/"), true);
  assert.equal(isDriveShareHref(link.href), true);
  assert.equal(sanitizeExtra({ cloudLinks: [link] })?.cloudLinks?.[0]?.href, link.href);
  const rejected = "https://cloud.cumuluscloud.app/s/" + "ab".repeat(16);
  assert.equal(sanitizeExtra({ cloudLinks: [{ ...link, href: rejected }] })?.cloudLinks, undefined);
});

test("a password seals the body and a wrong password does not open it", async () => {
  const envelope = await sealWithPassword("appendix inside", "correct-horse", fast);
  assert.equal(envelope.ciphertext.includes("appendix"), false);
  assert.equal(await openWithPassword(envelope, "correct-horse"), "appendix inside");
  await assert.rejects(() => openWithPassword(envelope, "wrong-horse"), /password/);
  const spent = spendRead({ ...envelope, selfDestruct: true, readsLeft: 1 });
  assert.equal(spent.ciphertext, "");
  await assert.rejects(() => openWithPassword({ ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" }, "correct-horse"), /expired/);
});

test("sieve archives a sender and labels another", () => {
  const source = `
    if header :contains "From" "vyral" {
      fileinto "archive";
      stop;
    }
    if header :contains "Subject" "appendix" {
      fileinto "label:Security";
      addflag "\\Starred";
    }
  `;
  assert.equal(parseSieve(source).length, 2);
  const vyral = SEED_MESSAGES.find((message) => message.from.email.includes("vyral"))!;
  assert.equal(applySieve(vyral, source).folder, "archive");
  const jordan = SEED_MESSAGES.find((message) => message.subject.includes("appendix"))!;
  const labeled = applySieve(jordan, source);
  assert.equal(labeled.labels.includes("Security"), true);
  assert.equal(labeled.starred, true);
  assert.throws(() => parseSieve('if header :contains "From" "a" {\n  redirect "evil";\n}'), /unsupported action/);
});

test("search operators and the encrypted index keep words out of the index", async () => {
  const rows = listThreads(SEED_MESSAGES, "inbox", "label:spectre", false);
  assert.equal(rows.every((row) => row.labels.includes("Spectre")), true);
  assert.equal(listThreads(SEED_MESSAGES, "sent", "in:sent", false).length > 0, true);
  assert.equal(listThreads(SEED_MESSAGES, "inbox", "in:trash", false).length, 0);
  const protectedMessage: MailMessage = { ...SEED_MESSAGES[0]!, id: "enc", threadId: "enc", extra: { pgp: true } };
  assert.equal(listThreads([protectedMessage], "inbox", "is:encrypted", false)[0]?.id, "enc");
  const index = await buildSearchIndex("The budget appendix is private", "tenant-secret");
  assert.equal(indexContainsPlaintext(index, "The budget appendix is private"), false);
  assert.equal(await queryIndex(index, "tenant-secret", "budget appendix"), true);
  assert.equal(await queryIndex(index, "other-secret", "budget"), false);
});

test("phishing, remote images, and calendar invites are classified without fetching them", () => {
  const phish: MailMessage = {
    ...SEED_MESSAGES[0]!,
    from: { name: "Cumulus Security", email: "security@cumulus-cloud.example" },
    body: "Verify your password at https://cumuluscloud.app.evil.test/login",
  };
  assert.equal(assessPhishing(phish).verdict, "phishing");
  assert.equal(classifyLink("https://xn--cumulus-123.example").suspicious, true);
  const images = stripRemoteImages('Hello <img src="https://tracker.example/pixel.gif" alt="">');
  assert.equal(images.blocked, 1);
  assert.equal(images.html.includes("tracker.example"), false);
  const invite = parseInvite("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Thursday briefing\nDTSTART:20261105T200000Z\nLOCATION:Cumulus\nORGANIZER:mailto:priya@vyral.london\nUID:brief-1\nEND:VEVENT\nEND:VCALENDAR");
  assert.equal(invite?.title, "Thursday briefing");
  assert.equal(invite?.with, "priya@vyral.london");
});

test("scheduled mail waits, and the bridge and identity stay outside this app", () => {
  const draft: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "later",
    folder: "drafts",
    extra: { scheduleAt: "2000-01-01T00:00:00.000Z", heldUntil: "2099-01-01T00:00:00.000Z" },
  };
  const released = releaseDue([draft], Date.parse("2026-11-10T00:00:00.000Z"));
  assert.equal(released[0]?.folder, "sent");
  assert.equal(released[0]?.extra?.heldUntil, "2099-01-01T00:00:00.000Z");
  assert.equal(bridgeDesign().status, "deferred");
  assert.equal(identityPosture().issuer, SIGN_IN_ISSUER);
  assert.equal(identityPosture().twoFactor, "delegated-to-google");
});

test("OpenPGP round-trips without putting the private key in the ciphertext", async () => {
  const ada = await generateMailKey("Ada", "ada@cumuluscloud.app", "passphrase-ada");
  const sealed = await encryptFor("security appendix", [ada.publicKey]);
  assert.equal(sealed.includes("security appendix"), false);
  assert.equal(sealed.includes(ada.privateKey), false);
  assert.equal(await decryptWith(sealed, ada.privateKey, "passphrase-ada"), "security appendix");
});

test("plus addresses, catch-all, auto-reply, holds, and sealed contact fields", async () => {
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    const ada = profile("par-ada", "ada.par@cumuluscloud.app", "Ada");
    const bea = profile("par-bea", "bea.par@cumuluscloud.app", "Bea");
    await openMailbox(db, "par-ada", ada);
    await openMailbox(db, "par-bea", bea);
    assert.equal(await findTenantByAddress(db, "ada.par+bills@cumuluscloud.app"), "par-ada");

    const txt = expectedTxt("client.test");
    const empty: MailboxSnapshot = {
      me: bea,
      messages: [],
      aliases: [],
      briefs: {},
      tasks: [],
      contacts: [],
      signature: "",
      rules: [],
      settings: {
        ...defaultSettings(),
        domains: [{ domain: "client.test", catchAll: true, verified: false, txtName: txt.name, txtValue: txt.value }],
      },
    };
    await writeSnapshot(db, storageFor, "par-bea", empty);
    assert.equal(await findTenantByAddress(db, "anyone@client.test"), null);
    const verified = await refreshDomainVerification(await readSettings(db, "par-bea"), async (name) => {
      return name === txt.name ? [[TXT_VALUE]] : [];
    });
    assert.equal(verified.domains[0]?.verified, true);
    await writeSettings(db, "par-bea", verified);
    const stored = await readSnapshot(db, "par-bea");
    await writeSnapshot(db, storageFor, "par-bea", { ...stored, settings: verified });
    assert.equal(await findTenantByAddress(db, "anyone@client.test"), "par-bea");
    const clientVerified = { ...verified, domains: verified.domains.map((domain) => ({ ...domain, verified: true })) };
    assert.equal(keepVerified(defaultSettings(), clientVerified).domains[0]?.verified, false);

    await writeSettings(db, "par-bea", {
      ...defaultSettings(),
      autoReply: { enabled: true, subject: "Away", body: "Out of office.", sent: [] },
    });
    const outgoing: MailMessage = {
      ...SEED_MESSAGES[0]!,
      id: "par-out",
      threadId: "par-out",
      folder: "sent",
      from: { name: "Ada", email: ada.email },
      to: [{ name: "Bea", email: bea.email }],
      cc: [],
      body: "Are you there?",
      labels: [],
    };
    await writeSnapshot(db, storageFor, "par-ada", {
      me: ada,
      messages: [outgoing],
      aliases: [],
      briefs: {},
      tasks: [],
      contacts: [],
      signature: "",
      rules: [],
    });
    const adaInbox = (await readMessages(db, "par-ada")).filter((message) => message.folder === "inbox");
    assert.equal(adaInbox.some((message) => message.body === "Out of office."), true);
    const afterFirst = await readSnapshot(db, "par-ada");
    await writeSnapshot(db, storageFor, "par-ada", {
      ...afterFirst,
      messages: [...afterFirst.messages, { ...outgoing, id: "par-out-2", threadId: "par-out-2" }],
    });
    const replies = (await readMessages(db, "par-ada")).filter((message) => message.body === "Out of office.");
    assert.equal(replies.length, 1);

    const held: MailMessage = {
      ...outgoing,
      id: "par-held",
      threadId: "par-held",
      body: "Please wait",
      extra: { heldUntil: "2099-01-01T00:00:00.000Z" },
    };
    await writeSnapshot(db, storageFor, "par-ada", {
      ...afterFirst,
      messages: [...afterFirst.messages, held],
    });
    assert.equal((await readMessages(db, "par-bea")).some((message) => message.body === "Please wait"), false);

    const envelope = await sealWithPassword("secret note", "correct-horse", { ...fast, selfDestruct: true, reads: 1 });
    const link = await issueProtectedLink(db, "par-ada", envelope);
    const opened = await readProtectedLink(db, link.token);
    assert.equal(await openWithPassword(opened.envelope, "correct-horse"), "secret note");
    await burnProtectedLink(db, link.token);
    await assert.rejects(() => readProtectedLink(db, link.token), /no longer available|does not exist/);

    await writeSnapshot(db, storageFor, "par-ada", {
      me: ada,
      messages: [],
      aliases: [],
      briefs: {},
      tasks: [],
      contacts: [{ id: "c-priya", name: "Priya", email: "priya@vyral.london", org: "VYRAL", note: "External", phone: "555-0100", address: "London", publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----" }],
      signature: "",
      rules: [],
    });
    const contact = (await readSnapshot(db, "par-ada")).contacts.find((item) => item.email === "priya@vyral.london");
    assert.equal(contact?.phone, "555-0100");
    const raw = await db.query<{ private_enc: string }>(`select private_enc from cumulus_mail.contacts where tenant_id = $1`, ["par-ada"]);
    assert.equal(raw[0]?.private_enc.includes("555-0100"), false);
  } finally {
    await harness.close();
  }
});
