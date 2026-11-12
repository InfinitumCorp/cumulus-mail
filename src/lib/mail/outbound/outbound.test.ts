import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "../mailbox.ts";
import type { MailMessage } from "../model.ts";
import { readSnapshot } from "../records.ts";
import type { MailboxSnapshot } from "../snapshot.ts";
import { createSuppressionList } from "../suppression.ts";
import { createHarness, profile } from "../test-support.ts";
import { configureOutbound, outboundEnabled, outboundFromEnv, type OutboundConfig } from "./config.ts";
import { buildRawMessage } from "./message.ts";
import { backoffMs, processOutboundQueue } from "./queue.ts";
import { createSmtpTransport, dotStuff, type SmtpSocket } from "./smtp.ts";
import { createMemoryTransport, type OutboundTransport, type RecipientResult } from "./transport.ts";

/** A fake SMTP server: answers each client line from a script and records what it got. */
function scriptedServer(replies: Record<string, string>, greeting = "220 mx.test ESMTP") {
  const received: string[] = [];
  const queue: string[] = [];
  let inData = false;
  let tls = false;
  const push = (reply: string) => queue.push(...reply.split("\n"));
  push(greeting);
  const socket: SmtpSocket = {
    async write(data) {
      received.push(data);
      if (inData) {
        inData = false;
        push(replies["."] ?? "250 2.0.0 queued");
        return;
      }
      const verb = data.trim().split(/[ :]/)[0]!.toUpperCase();
      if (verb === "DATA") inData = true;
      const key = Object.keys(replies).find((name) => data.trim().toUpperCase().startsWith(name.toUpperCase()));
      push(key ? replies[key]! : verb === "QUIT" ? "221 bye" : "250 ok");
    },
    async readLine() {
      const line = queue.shift();
      if (line === undefined) throw new Error("server has nothing to say");
      return line;
    },
    async startTls() {
      tls = true;
    },
    async close() {},
  };
  return { socket, received, isTls: () => tls };
}

function transportFor(server: ReturnType<typeof scriptedServer>, security: "tls" | "starttls" | "none" = "none", user?: string) {
  return createSmtpTransport({ host: "mx.test", port: 587, security, helo: "cumuluscloud.app", user, password: "pw", dial: async () => server.socket });
}

test("SMTP sends one message: EHLO, STARTTLS, AUTH, MAIL, RCPT, DATA with dot-stuffing", async () => {
  const server = scriptedServer({ EHLO: "250-mx.test\n250-STARTTLS\n250 AUTH PLAIN", STARTTLS: "220 go ahead", AUTH: "235 ok", DATA: "354 send" });
  const results = await transportFor(server, "starttls", "relay-user").send({
    from: "ada@cumuluscloud.app",
    to: ["bea@example.org"],
    raw: "Subject: x\r\n\r\n.hidden line\r\nend",
  });
  assert.deepEqual(results.map((result) => result.ok), [true]);
  assert.equal(server.isTls(), true);
  const lines = server.received.map((line) => line.split("\r\n")[0]);
  assert.deepEqual(lines.slice(0, 4), ["EHLO cumuluscloud.app", "STARTTLS", "EHLO cumuluscloud.app", `AUTH PLAIN ${Buffer.from("\0relay-user\0pw").toString("base64")}`]);
  assert.ok(server.received.includes("MAIL FROM:<ada@cumuluscloud.app>\r\n"));
  assert.ok(server.received.includes("RCPT TO:<bea@example.org>\r\n"));
  assert.ok(server.received.some((data) => data.includes("\r\n..hidden line\r\nend\r\n.\r\n")));
  assert.equal(dotStuff(".a\n.b"), "..a\r\n..b\r\n.\r\n");
});

test("SMTP maps 5xx to permanent, 4xx to retry, and refuses a server without STARTTLS", async () => {
  const rejected = await transportFor(scriptedServer({ "RCPT TO:<gone": "550 5.1.1 No such user", DATA: "354 send" })).send({
    from: "ada@cumuluscloud.app",
    to: ["gone@example.org", "busy@example.org"],
    raw: "x",
  });
  const gone = rejected.find((result) => result.recipient === "gone@example.org") as Extract<RecipientResult, { ok: false }>;
  assert.equal(gone.ok, false);
  assert.equal(gone.permanent, true);
  assert.equal(gone.status, "5.1.1");
  assert.equal(rejected.find((result) => result.recipient === "busy@example.org")?.ok, true);

  const later = await transportFor(scriptedServer({ "MAIL FROM": "451 4.3.0 try later" })).send({ from: "ada@cumuluscloud.app", to: ["x@example.org"], raw: "x" });
  assert.equal(later[0]?.ok, false);
  assert.equal((later[0] as Extract<RecipientResult, { ok: false }>).permanent, false);

  const plain = await transportFor(scriptedServer({ EHLO: "250 mx.test" }), "starttls").send({ from: "ada@cumuluscloud.app", to: ["x@example.org"], raw: "x" });
  assert.match((plain[0] as Extract<RecipientResult, { ok: false }>).detail, /STARTTLS/);
  assert.equal((plain[0] as Extract<RecipientResult, { ok: false }>).permanent, false);

  await assert.rejects(async () => {
    const results = await transportFor(scriptedServer({})).send({ from: "bad\r\nRCPT", to: ["x@example.org"], raw: "x" });
    if (!results[0]?.ok) throw new Error((results[0] as { detail: string }).detail);
  }, /invalid address/);
});

test("env config: off without MAIL_SMTP_HOST, validated when on", () => {
  assert.equal(outboundFromEnv({}), null);
  assert.equal(outboundEnabled({}), false);
  assert.equal(outboundEnabled({ MAIL_SMTP_HOST: "smtp.example.org" }), true);
  const on = outboundFromEnv({ MAIL_SMTP_HOST: "smtp.example.org", MAIL_SMTP_PORT: "465" }, async () => {
    throw new Error("must not dial while building config");
  });
  assert.equal(on?.transport.name, "smtp:smtp.example.org");
  assert.equal(on?.dkim, null);
  assert.throws(() => outboundFromEnv({ MAIL_SMTP_HOST: "h", MAIL_SMTP_PORT: "99999" }), /port/);
  assert.throws(() => outboundFromEnv({ MAIL_SMTP_HOST: "h", MAIL_SMTP_SECURITY: "none" }), /tls or starttls/);
  assert.throws(() => outboundFromEnv({ MAIL_SMTP_HOST: "h", MAIL_DKIM_SELECTOR: "s1" }), /MAIL_DKIM_KEY_PATH/);
  assert.equal(outboundFromEnv({ MAIL_OUTBOUND_DEV: "memory" })?.transport.name, "memory");
});

test("backoff doubles from the base and stops at the cap", () => {
  const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => backoffMs(attempt, policy)), [1000, 2000, 4000, 5000, 5000]);
});

test("the outgoing message is plain RFC 5322 with encoded non-ASCII headers", () => {
  const raw = buildRawMessage(
    {
      id: "m-1",
      threadId: "m-1",
      folder: "sent",
      from: { name: "Ada", email: "ada@cumuluscloud.app" },
      to: [{ name: "Zoë", email: "zoe@example.org" }],
      cc: [],
      subject: "Café\r\nBcc: injected@example.org",
      body: "Hello ✓",
      at: "2026-11-01T00:00:00.000Z",
      unread: false,
      starred: false,
      labels: [],
    },
    { name: "Ada", email: "ada@cumuluscloud.app" },
    "cumuluscloud.app",
    new Date("2026-11-12T10:00:00Z"),
  );
  assert.match(raw, /^From: "Ada" <ada@cumuluscloud.app>\r\nTo: =\?UTF-8\?B\?[^?]+\?= <zoe@example.org>\r\n/);
  assert.equal(/\r\nBcc:/i.test(raw), false);
  assert.match(raw, /\r\nMessage-ID: <m-1@cumuluscloud.app>\r\n/);
  assert.match(raw, /\r\nDate: Thu, 12 Nov 2026 10:00:00 \+0000\r\n/);
  const body = raw.split("\r\n\r\n")[1]!;
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hello ✓");
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

afterEach(() => {
  configureOutbound(undefined);
});

after(async () => {
  await harness.close();
});

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[]): MailboxSnapshot {
  return { me, messages, aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
}

function sent(id: string, from: string, to: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: id,
    folder: "sent",
    from: { name: "Ada", email: from },
    to: [{ name: "Out", email: to }],
    cc: [],
    subject: `Subject ${id}`,
    body: `Body ${id}`,
    at: "2026-11-12T10:00:00.000Z",
    unread: false,
    starred: false,
    labels: [],
    ...extra,
  };
}

async function hopFor(tenantId: string, messageId: string): Promise<string | undefined> {
  return (await readSnapshot(harness.db, tenantId)).messages.find((message) => message.id === messageId)?.delivery?.[0]?.detail;
}

test("with no SMTP config, external mail is held exactly as before and nothing is queued", async () => {
  const { db, storageFor } = harness;
  configureOutbound(null);
  const ada = profile("ob-off", "off.ob@cumuluscloud.app", "Ada");
  await openMailbox(db, "ob-off", ada);
  await writeSnapshot(db, storageFor, "ob-off", snapshot(ada, [sent("off-1", ada.email, "someone@example.org")]));
  assert.match((await hopFor("ob-off", "off-1")) ?? "", /^Held in the outbox\. This preview does not send outside Cumulus\.$/);
  const rows = await db.query(`select 1 from cumulus_mail.outbound_queue where tenant_id = $1`, ["ob-off"]);
  assert.equal(rows.length, 0);
});

test("with the dev transport, external mail is queued, DKIM-signed and sent once", async () => {
  const { db, storageFor } = harness;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const transport = createMemoryTransport();
  configureOutbound({ transport, dkim: { selector: "sel1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() } });
  const ada = profile("ob-dev", "dev.ob@cumuluscloud.app", "Ada");
  await openMailbox(db, "ob-dev", ada);
  await writeSnapshot(db, storageFor, "ob-dev", snapshot(ada, [sent("dev-1", "spoof@example.org", "bea@example.org")]));
  assert.equal(transport.sent.length, 1);
  const envelope = transport.sent[0]!;
  assert.equal(envelope.from, ada.email);
  assert.deepEqual(envelope.to, ["bea@example.org"]);
  assert.match(envelope.raw, /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=cumuluscloud.app; s=sel1;/);
  assert.match(envelope.raw, /\r\nFrom: "Ada" <dev.ob@cumuluscloud.app>\r\n/);
  assert.match((await hopFor("ob-dev", "dev-1")) ?? "", /^Sent by SMTP\./);

  // Saving again does not send again.
  await writeSnapshot(db, storageFor, "ob-dev", await readSnapshot(db, "ob-dev"));
  assert.equal(transport.sent.length, 1);
});

test("a transient failure retries with backoff, then bounces; a permanent one bounces and suppresses", async () => {
  const { db, storageFor } = harness;
  let reply: (to: string) => RecipientResult = (to) => ({ recipient: to, ok: false, permanent: false, status: "4.4.1", detail: "451 4.4.1 timeout" });
  const calls: string[] = [];
  const flaky: OutboundTransport = {
    name: "flaky",
    async send(envelope) {
      calls.push(envelope.to[0]!);
      return envelope.to.map((to) => reply(to));
    },
  };
  const config: OutboundConfig = { transport: flaky, dkim: null };
  configureOutbound(config);
  const ada = profile("ob-retry", "retry.ob@cumuluscloud.app", "Ada");
  await openMailbox(db, "ob-retry", ada);
  await writeSnapshot(db, storageFor, "ob-retry", snapshot(ada, [sent("r-1", ada.email, "slow@example.org")]));
  assert.equal(calls.length, 1);
  assert.match((await hopFor("ob-retry", "r-1")) ?? "", /^Retrying after 4\.4\.1\./);

  const policy = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000 };
  const start = Date.now();
  // Not due yet: nothing happens.
  assert.deepEqual(await processOutboundQueue(db, config, { tenantId: "ob-retry", now: new Date(start + 30_000), policy }), { sent: 0, retried: 0, bounced: 0 });
  assert.deepEqual(await processOutboundQueue(db, config, { tenantId: "ob-retry", now: new Date(start + 61_000), policy }), { sent: 0, retried: 1, bounced: 0 });
  // Third attempt is the last: it becomes a bounce, but a transient one does not suppress.
  assert.deepEqual(await processOutboundQueue(db, config, { tenantId: "ob-retry", now: new Date(start + 10 * 60_000), policy }), { sent: 0, retried: 0, bounced: 1 });
  assert.match((await hopFor("ob-retry", "r-1")) ?? "", /^Bounced \(4\.4\.1\)/);
  assert.equal(await createSuppressionList(db, "ob-retry").has("slow@example.org"), false);

  reply = (to) => ({ recipient: to, ok: false, permanent: true, status: "5.1.1", detail: "550 5.1.1 No such user" });
  await writeSnapshot(db, storageFor, "ob-retry", snapshot(ada, [...(await readSnapshot(db, "ob-retry")).messages, sent("r-2", ada.email, "gone@example.org")]));
  assert.match((await hopFor("ob-retry", "r-2")) ?? "", /^Bounced \(5\.1\.1\)/);
  assert.equal(await createSuppressionList(db, "ob-retry").has("gone@example.org"), true);
  const bounces = await db.query<{ status: string; message_id: string }>(
    `select status, message_id from cumulus_mail.bounces where tenant_id = $1 order by status`,
    ["ob-retry"],
  );
  assert.deepEqual(bounces.map((row) => [row.message_id, row.status]), [["r-1", "4.4.1"], ["r-2", "5.1.1"]]);
});

test("attachments go out as multipart/mixed and parse back byte for byte", async () => {
  const { db, storageFor } = harness;
  const transport = createMemoryTransport();
  configureOutbound({ transport, dkim: null });
  const ada = profile("ob-att", "att.ob@cumuluscloud.app", "Ada");
  await openMailbox(db, "ob-att", ada);
  const pdf = new Uint8Array(70_000).map((_, index) => index % 251);
  await writeSnapshot(db, storageFor, "ob-att", snapshot(ada, [
    sent("att-1", ada.email, "bea@example.org", {
      body: "Two files ✓",
      attachments: [
        { name: "report.pdf", size: pdf.byteLength, contentType: "application/pdf", dataBase64: Buffer.from(pdf).toString("base64") },
        { name: "Résumé \"final\".txt", size: 3, contentType: "text/plain\r\nX-Evil: 1", dataBase64: Buffer.from("abc").toString("base64") },
      ],
    }),
  ]));
  assert.equal(transport.sent.length, 1);
  const raw = transport.sent[0]!.raw;
  assert.match(raw, /\r\nContent-Type: multipart\/mixed; boundary="=_cumulus_/);
  assert.equal(/\r\nX-Evil:/i.test(raw), false);
  assert.ok(raw.split("\r\n").every((line) => line.length <= 998));
  const { parseMime } = await import("../mime.ts");
  const parsed = parseMime(raw);
  assert.equal(parsed.text, "Two files ✓");
  assert.deepEqual(parsed.attachments.map((file) => [file.name, file.contentType, file.bytes.byteLength]), [
    ["report.pdf", "application/pdf", 70_000],
    ["R_sum_ _final_.txt", "application/octet-stream", 3],
  ]);
  assert.deepEqual([...parsed.attachments[0]!.bytes.slice(0, 5)], [0, 1, 2, 3, 4]);
  assert.match(raw, /filename\*=UTF-8''R%C3%A9sum%C3%A9%20_final_.txt/);
  assert.match((await hopFor("ob-att", "att-1")) ?? "", /^Sent by SMTP\./);
});
