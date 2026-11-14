import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  claimExport,
  dataJson,
  dataJsonText,
  DAY_MS,
  escapeFromLines,
  exportToken,
  fromLine,
  mboxEntry,
  mboxStream,
  nextExportAt,
  rebuildMessage,
  TOKEN_TTL_MS,
  verifyExportToken,
} from "./data-export.ts";
import { openMailbox } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { insertAttachment, insertMessage } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: "m1",
  threadId: "t1",
  folder: "inbox",
  from: { name: "Leah Okonkwo", email: "leah@cumuluscloud.app" },
  to: [{ name: "Alex", email: "alex@cumuluscloud.app" }],
  cc: [],
  subject: "Budget",
  body: "Numbers attached.\nFrom the team.",
  at: "2026-11-10T09:30:00.000Z",
  unread: false,
  starred: true,
  labels: ["Finance"],
  ...over,
});

const read = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));

test("mboxrd: every From-line inside a message gets one more >", () => {
  assert.equal(escapeFromLines("From here\n>From there\nnot From me"), ">From here\n>>From there\nnot From me");
});

test("the separator line is From <address> <asctime>", () => {
  assert.equal(fromLine(message()), "From leah@cumuluscloud.app Tue Nov 10 09:30:00 2026");
  assert.equal(fromLine(message({ at: "not a date" })), "From leah@cumuluscloud.app Thu Jan  1 00:00:00 1970");
});

test("a rebuilt message is valid RFC 822 with folder, flags and a base64 body", () => {
  const text = rebuildMessage(message());
  assert.match(text, /^From: "Leah Okonkwo" <leah@cumuluscloud\.app>\r\n/);
  assert.match(text, /\r\nTo: "Alex" <alex@cumuluscloud\.app>\r\n/);
  assert.match(text, /\r\nSubject: Budget\r\n/);
  assert.match(text, /\r\nX-Cumulus-Folder: inbox\r\n/);
  assert.match(text, /\r\nX-Cumulus-Flags: Seen Flagged\r\n/);
  const body = text.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Numbers attached.\nFrom the team.");
});

test("a header cannot be split by a newline in the data", () => {
  const text = rebuildMessage(message({ subject: "Hi\r\nBcc: victim@example.com" }));
  assert.equal(/\r\nBcc:/.test(text), false);
});

test("a non-ASCII subject is an encoded word", () => {
  assert.match(rebuildMessage(message({ subject: "Бюджет" })), /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
});

test("an mbox entry ends with a blank line and escapes From lines in the body", () => {
  const entry = mboxEntry(message(), "Subject: x\r\n\r\nFrom the start\r\n");
  assert.ok(entry.startsWith("From leah@cumuluscloud.app "));
  assert.ok(entry.includes("\n>From the start\n"));
  assert.ok(entry.endsWith("\n\n"));
});

test("the download link is signed, short-lived and bound to one mailbox and one part", () => {
  const now = 1_800_000_000_000;
  const token = exportToken("export-ada", "mbox", now);
  assert.deepEqual(verifyExportToken(token, now), { tenantId: "export-ada", part: "mbox" });
  assert.equal(verifyExportToken(token, now + TOKEN_TTL_MS + 1), null, "expired");
  const [tenant, , expiry, mac] = token.split(".");
  assert.equal(verifyExportToken(`${tenant}.json.${expiry}.${mac}`, now), null, "the part cannot be swapped");
  const other = Buffer.from("export-bea").toString("base64url");
  assert.equal(verifyExportToken(`${other}.mbox.${expiry}.${mac}`, now), null, "the mailbox cannot be swapped");
  assert.equal(verifyExportToken(`${tenant}.mbox.${Number(expiry) + 99999}.${mac}`, now), null, "the expiry cannot be extended");
  assert.equal(verifyExportToken("garbage", now), null);
  assert.equal(verifyExportToken(token, now, { MAIL_BLOB_KEY: "cd".repeat(32) }), null, "another deployment's key does not verify");
});

test("once a day per part: the first claim wins, a second within 24h does not, then it reopens", async () => {
  const { db } = harness;
  await openMailbox(db, "export-limit", profile("export-limit", "limit@cumuluscloud.app"));
  const start = new Date("2026-11-13T10:00:00Z");
  assert.equal(await nextExportAt(db, "export-limit", "mbox", start), null);
  assert.equal(await claimExport(db, "export-limit", "mbox", start), true);
  assert.equal(await claimExport(db, "export-limit", "mbox", new Date(start.getTime() + 60_000)), false);
  assert.equal((await nextExportAt(db, "export-limit", "mbox", start))?.toISOString(), "2026-11-14T10:00:00.000Z");
  assert.equal(await claimExport(db, "export-limit", "json", start), true, "the other part has its own day");
  assert.equal(await claimExport(db, "export-limit", "mbox", new Date(start.getTime() + DAY_MS)), true);
});

test("two simultaneous claims: exactly one wins", async () => {
  const { db } = harness;
  await openMailbox(db, "export-race", profile("export-race", "race@cumuluscloud.app"));
  const now = new Date("2026-11-13T10:00:00Z");
  const results = await Promise.all([claimExport(db, "export-race", "mbox", now), claimExport(db, "export-race", "mbox", now)]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("the full export: every message in the mbox (original bytes, rebuilt mail with attachments) and the JSON", async () => {
  const { db, storageFor } = harness;
  const tenant = "export-full";
  await openMailbox(db, tenant, profile(tenant, "full@cumuluscloud.app", "Full"));
  const storage = storageFor(tenant);

  // Arrived from outside: the stored original is exported byte for byte.
  const original = "From: outside@example.com\r\nSubject: Original\r\n\r\nFrom the original bytes.\r\n";
  const raw = await storage.put(new TextEncoder().encode(original));
  await insertMessage(db, tenant, message({ id: "in-1", subject: "Original", at: "2026-11-01T00:00:00.000Z" }), raw.blobId);

  // Written in the app, with an attachment: rebuilt, attachment as a MIME part.
  const pdf = new TextEncoder().encode("%PDF-1.4 tiny");
  const stored = await storage.put(pdf);
  await insertMessage(db, tenant, message({ id: "out-1", folder: "sent", subject: "With file", at: "2026-11-02T00:00:00.000Z" }), null);
  await insertAttachment(db, tenant, "out-1", {
    id: "att-1",
    name: "report.pdf",
    size: pdf.byteLength,
    contentType: "application/pdf",
    sha256: stored.sha256,
    objectKey: stored.blobId,
  });

  const mbox = await read(await mboxStream(db, storage, tenant));
  const entries = mbox.split(/^From \S+ \w{3} \w{3} +\d+ [\d:]+ \d{4}$/m).filter((part) => part.trim());
  assert.equal(entries.length, 2, "one entry per message");
  assert.ok(mbox.indexOf("Subject: Original") < mbox.indexOf("Subject: With file"), "oldest first");
  assert.ok(mbox.includes("\n>From the original bytes.\n"), "the original, From-escaped");
  assert.match(mbox, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.ok(mbox.includes(Buffer.from(pdf).toString("base64")), "the attachment's bytes are in the export");
  assert.ok(mbox.includes("X-Cumulus-Folder: sent"));

  const json = JSON.parse(await dataJsonText(db, tenant, new Date("2026-11-13T10:00:00Z")));
  assert.equal(json.format, "cumulus-mail/data-export");
  assert.equal(json.messages.count, 2);
  for (const key of ["account", "contacts", "calendar", "folders", "aliases", "rules", "tasks", "settings", "signature"]) {
    assert.ok(key in json, `data.json has ${key}`);
  }
  assert.equal(json.account.email, "full@cumuluscloud.app");
});

test("one mailbox's export never contains another's mail", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "export-ann", profile("export-ann", "ann@cumuluscloud.app"));
  await openMailbox(db, "export-ben", profile("export-ben", "ben@cumuluscloud.app"));
  await insertMessage(db, "export-ann", message({ id: "ann-1", subject: "Ann's secret" }), null);
  await insertMessage(db, "export-ben", message({ id: "ben-1", subject: "Ben's note" }), null);
  const ann = await read(await mboxStream(db, storageFor("export-ann"), "export-ann"));
  assert.ok(ann.includes("Ann's secret"));
  assert.equal(ann.includes("Ben's note"), false);
  assert.equal(JSON.stringify(dataJson({ me: profile("x", "x@cumuluscloud.app"), messages: [], aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] })).includes("Ben"), false);
});
