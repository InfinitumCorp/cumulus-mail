import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseHeaders, parseMime } from "../mime.ts";
import type { MailMessage } from "../model.ts";
import { openMailbox } from "../mailbox.ts";
import { createHarness, profile } from "../test-support.ts";
import type { OutboundConfig } from "./config.ts";
import { buildRawMessage, encodeWord, estimatedRawBytes } from "./message.ts";
import { enqueueOutbound, processOutboundQueue } from "./queue.ts";
import type { OutboundTransport } from "./transport.ts";

function message(extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m-1",
    threadId: "m-1",
    folder: "sent",
    from: { name: "Ada", email: "ada@cumuluscloud.app" },
    to: [{ name: "Bea", email: "bea@example.org" }],
    cc: [],
    subject: "Hello",
    body: "Body",
    at: "2026-11-01T00:00:00.000Z",
    unread: false,
    starred: false,
    labels: [],
    ...extra,
  };
}

const ADA = { name: "Ada", email: "ada@cumuluscloud.app" };
const headerBlock = (raw: string) => raw.slice(0, raw.indexOf("\r\n\r\n"));

test("no header line passes 998 characters, even with many recipients and a long non-ASCII subject", () => {
  const to = Array.from({ length: 120 }, (_, index) => ({ name: `Recipient Number ${index}`, email: `person${index}@example.org` }));
  const subject = "Résumé — quarterly numbers ✓ ".repeat(20).trim();
  const raw = buildRawMessage(message({ to, subject }), ADA, "cumuluscloud.app");
  const lines = headerBlock(raw).split("\r\n");
  assert.ok(lines.every((line) => line.length <= 998), `longest ${Math.max(...lines.map((line) => line.length))}`);
  const words = headerBlock(raw).match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
  assert.ok(words.length > 1);
  assert.ok(words.every((word) => word.length <= 75));
  // Folded headers parse back to the same values.
  const parsed = parseMime(raw);
  assert.equal(parsed.subject, subject);
  assert.equal(parsed.to.length, 120);
  assert.equal(parsed.to[119]?.email, "person119@example.org");
});

test("encoded words never split a character", () => {
  const value = "😀".repeat(40);
  const words = encodeWord(value).split("\r\n ");
  for (const word of words) {
    const text = Buffer.from(word.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8");
    assert.equal(text.includes("�"), false);
  }
  assert.equal(encodeWord("plain ascii"), "plain ascii");
});

test("display names are escaped, and addresses that could break the header are refused", () => {
  const raw = buildRawMessage(message({ to: [{ name: 'Bea "B" \\ Team', email: "bea@example.org" }] }), ADA, "cumuluscloud.app");
  assert.match(raw, /\r\nTo: "Bea \\"B\\" \\\\ Team" <bea@example\.org>\r\n/);
  const headers = parseHeaders(headerBlock(raw));
  assert.equal(Object.keys(headers).filter((name) => name === "bcc").length, 0);
  for (const email of ["bea@example.org\r\nBcc: x@evil.example", "a b@example.org", "a@b@example.org", 'a"b@example.org', "plain"]) {
    assert.throws(() => buildRawMessage(message({ to: [{ name: "X", email }] }), ADA, "cumuluscloud.app"), /Invalid address/, email);
  }
  // CR/LF in a name or subject never starts a new header.
  const sneaky = buildRawMessage(
    message({ to: [{ name: "Bea\r\nBcc: x@evil.example", email: "bea@example.org" }], subject: "Hi\r\nBcc: x@evil.example" }),
    ADA,
    "cumuluscloud.app",
  );
  assert.equal(/\r\nBcc:/i.test(sneaky), false);
});

test("the size estimate is an upper bound, so big mail is held before reading attachment bytes", () => {
  const files = [
    { name: "a.bin", contentType: "application/octet-stream", bytes: new Uint8Array(300_000) },
    { name: "b.bin", contentType: "application/octet-stream", bytes: new Uint8Array(12_345) },
  ];
  const body = "Body ✓ ".repeat(1000);
  const raw = buildRawMessage(message({ body }), ADA, "cumuluscloud.app", new Date(), files);
  assert.ok(estimatedRawBytes(body.length, files.map((file) => file.bytes.byteLength)) >= raw.length);
  // 8 attachments of 25 MB (what a save allows) is far over the cap, from sizes alone.
  assert.ok(estimatedRawBytes(0, Array(8).fill(25 * 1024 * 1024)) > 24 * 1024 * 1024);
  assert.ok(estimatedRawBytes(10, [1000]) < 24 * 1024 * 1024);
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("one row that throws does not stop the run, leak the error text, or strand other rows", async () => {
  const { db } = harness;
  const ada = profile("hard-q", "q.hard@cumuluscloud.app", "Ada");
  await openMailbox(db, "hard-q", ada);
  for (const to of ["boom@example.org", "fine@example.org"]) {
    await enqueueOutbound(db, "hard-q", { messageId: `m-${to}`, from: ada.email, recipient: to, raw: "Subject: x\r\n\r\ny\r\n" });
  }
  const sent: string[] = [];
  const transport: OutboundTransport = {
    name: "flaky",
    async send(envelope) {
      if (envelope.to[0] === "boom@example.org") throw new TypeError("secret-looking internal detail");
      sent.push(envelope.to[0]!);
      return envelope.to.map((recipient) => ({ recipient, ok: true as const, detail: "250 ok" }));
    },
  };
  const config: OutboundConfig = { transport, dkim: null };
  const report = await processOutboundQueue(db, config, { tenantId: "hard-q" });
  assert.deepEqual(report, { sent: 1, retried: 1, bounced: 0 });
  assert.deepEqual(sent, ["fine@example.org"]);
  const rows = await db.query<{ status: string; last_error: string | null }>(
    `select status, last_error from cumulus_mail.outbound_queue where tenant_id = $1 order by status`,
    ["hard-q"],
  );
  assert.deepEqual(rows.map((row) => row.status), ["queued", "sent"]);
  assert.equal(rows[0]?.last_error, "Local error before sending (TypeError).");
  assert.equal(JSON.stringify(rows).includes("secret-looking"), false);

  // A DKIM key that will not load is handled the same way, and the key never reaches the database.
  await enqueueOutbound(db, "hard-q", { messageId: "m-dkim", from: ada.email, recipient: "dkim@example.org", raw: "Subject: x\r\n\r\ny\r\n" });
  const badKey = "-----BEGIN PRIVATE KEY-----\nNOTAKEY\n-----END PRIVATE KEY-----";
  const dkimReport = await processOutboundQueue(db, { transport, dkim: { selector: "s1", privateKeyPem: badKey } }, { tenantId: "hard-q" });
  assert.equal(dkimReport.retried >= 1, true);
  const all = await db.query(`select * from cumulus_mail.outbound_queue where tenant_id = $1`, ["hard-q"]);
  assert.equal(JSON.stringify(all).includes("NOTAKEY"), false);
});

test("DKIM signs only mail from the key's domain (or a subdomain); other senders go out unsigned", async () => {
  const { dkimDomainFor } = await import("./queue.ts");
  const { outboundFromEnv } = await import("./config.ts");
  const { generateKeyPairSync } = await import("node:crypto");
  assert.equal(dkimDomainFor("ada@cumuluscloud.app", "cumuluscloud.app"), "cumuluscloud.app");
  assert.equal(dkimDomainFor("ada@eu.cumuluscloud.app", "cumuluscloud.app"), "cumuluscloud.app");
  assert.equal(dkimDomainFor("ada@customer.example", "cumuluscloud.app"), null);
  assert.equal(dkimDomainFor("ada@evilcumuluscloud.app", "cumuluscloud.app"), null);
  assert.equal(dkimDomainFor("ada@customer.example", undefined), "customer.example");
  assert.equal(dkimDomainFor("no-at-sign", "cumuluscloud.app"), null);

  const pem = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const config = outboundFromEnv({ MAIL_OUTBOUND_DEV: "memory", MAIL_DKIM_SELECTOR: "s1", MAIL_DKIM_PRIVATE_KEY: pem, MAIL_DKIM_DOMAIN: "CumulusCloud.app" });
  assert.equal(config?.dkim?.domain, "cumuluscloud.app");
  const sent: string[] = [];
  const transport: OutboundTransport = {
    name: "capture",
    async send(envelope) {
      sent.push(envelope.raw);
      return envelope.to.map((recipient) => ({ recipient, ok: true as const, detail: "250 ok" }));
    },
  };
  const { db } = harness;
  const ada = profile("hard-dkim", "dkim.hard@cumuluscloud.app", "Ada");
  await openMailbox(db, "hard-dkim", ada);
  await enqueueOutbound(db, "hard-dkim", { messageId: "m-platform", from: ada.email, recipient: "x@example.org", raw: "From: a\r\nSubject: x\r\n\r\ny\r\n" });
  await enqueueOutbound(db, "hard-dkim", { messageId: "m-custom", from: "ada@customer.example", recipient: "y@example.org", raw: "From: a\r\nSubject: x\r\n\r\ny\r\n" });
  await processOutboundQueue(db, { transport, dkim: config!.dkim }, { tenantId: "hard-dkim" });
  assert.equal(sent.length, 2);
  assert.equal(sent.filter((raw) => raw.startsWith("DKIM-Signature: ") && raw.includes("; d=cumuluscloud.app;")).length, 1);
  assert.equal(sent.filter((raw) => !raw.startsWith("DKIM-Signature")).length, 1);
});
