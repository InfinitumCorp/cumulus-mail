import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ingestInboundEmail } from "../inbound.ts";
import { openMailbox } from "../mailbox.ts";
import type { MailMessage } from "../model.ts";
import { insertAttachment, insertMessage, readSettings, writeSettings } from "../records.ts";
import { createHarness, profile } from "../test-support.ts";
import { appendMaxBytes, bridgeWriteEnabled, idleSeconds, READ_SCOPE, WRITE_SCOPE } from "./config.ts";
import { authorize } from "./http.ts";
import { waitForChange } from "./idle.ts";
import { resetRateLimits } from "./sync.ts";
import { BridgeWriteOffError, checkToken, createToken } from "./tokens.ts";
import { changesSince, folderState, noteNewMessage, touchMessage } from "./uids.ts";
import { appendSentCopy, BridgeWriteError, moveMessages } from "./write.ts";

const KEY = process.env.MAIL_BLOB_KEY;
const READ_ONLY = { MAIL_BRIDGE: "on", MAIL_BLOB_KEY: KEY };
const WRITE = { MAIL_BRIDGE: "on", MAIL_BRIDGE_WRITE: "on", MAIL_BLOB_KEY: KEY };

afterEach(() => resetRateLimits());

const message = (id: string, folder: MailMessage["folder"]): MailMessage => ({
  id,
  threadId: id,
  folder,
  from: { name: "Leah", email: "leah@cumuluscloud.app" },
  to: [{ name: "Ada", email: "ada@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body: `Body ${id}`,
  at: "2026-11-10T09:30:00.000Z",
  unread: true,
  starred: false,
  labels: [],
});

async function mailbox(tenant: string) {
  const harness = await createHarness();
  await openMailbox(harness.db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  return harness;
}

async function placed(harness: Awaited<ReturnType<typeof createHarness>>, tenant: string, id: string, folder: MailMessage["folder"]) {
  await insertMessage(harness.db, tenant, message(id, folder), null);
  return touchMessage(harness.db, tenant, folder, id);
}

const folderOf = async (harness: Awaited<ReturnType<typeof createHarness>>, tenant: string, id: string) =>
  (await harness.db.query<{ folder: string }>(`select folder from cumulus_mail.messages where tenant_id = $1 and id = $2`, [tenant, id]))[0]?.folder;

const rfc822 = (from: string, subject: string, extra = "") =>
  new TextEncoder().encode(
    [`From: Ada <${from}>`, "To: Leah <leah@example.org>", `Subject: ${subject}`, "Date: Tue, 10 Nov 2026 09:30:00 +0000", "Content-Type: text/plain", "", `Sent body ${subject}${extra}`].join("\r\n"),
  );

// --- switches and scopes -------------------------------------------------------------------------

test("writes are off unless MAIL_BRIDGE_WRITE=on as well as MAIL_BRIDGE=on", () => {
  assert.equal(bridgeWriteEnabled({}), false);
  assert.equal(bridgeWriteEnabled({ MAIL_BRIDGE_WRITE: "on" }), false, "the write switch alone does nothing");
  assert.equal(bridgeWriteEnabled({ MAIL_BRIDGE: "on" }), false);
  assert.equal(bridgeWriteEnabled(WRITE), true);
  assert.equal(idleSeconds({}), 25);
  assert.equal(idleSeconds({ MAIL_BRIDGE_IDLE_SECONDS: "600" }), 60, "capped");
  assert.equal(appendMaxBytes({ MAIL_BRIDGE_APPEND_BYTES: "1000" }), 1000);
});

test("a write token needs the write switch to be made, and to be used; read tokens never write", async () => {
  const harness = await mailbox("bw-scope");
  try {
    await assert.rejects(() => createToken(harness.db, "bw-scope", "Mail", { env: READ_ONLY, write: true }), BridgeWriteOffError);
    const reader = await createToken(harness.db, "bw-scope", "Reader", { env: WRITE });
    const writer = await createToken(harness.db, "bw-scope", "Writer", { env: WRITE, write: true });
    assert.equal(reader.record.scope, READ_SCOPE);
    assert.equal(writer.record.scope, `${READ_SCOPE} ${WRITE_SCOPE}`);

    assert.equal((await checkToken(harness.db, `Bearer ${reader.token}`, { env: WRITE, need: "write" })).ok, false);
    assert.equal((await checkToken(harness.db, `Bearer ${writer.token}`, { env: WRITE, need: "write" })).ok, true);
    assert.equal((await checkToken(harness.db, `Bearer ${writer.token}`, { env: WRITE, need: "read" })).ok, true, "a write token also reads");
    // Turning the switch off makes every write token read-only at once.
    assert.deepEqual(await checkToken(harness.db, `Bearer ${writer.token}`, { env: READ_ONLY, need: "write" }), { ok: false, reason: "scope" });
    assert.equal((await checkToken(harness.db, `Bearer ${writer.token}`, { env: READ_ONLY, need: "read" })).ok, true);
  } finally {
    await harness.close();
  }
});

test("routes: 404 while off, 401 without a token, 403 for a read token on a write route", async () => {
  const harness = await mailbox("bw-http");
  try {
    const reader = await createToken(harness.db, "bw-http", "Reader", { env: WRITE });
    const req = (token?: string) => new Request("http://x/api/bridge/move", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(((await authorize(harness.db, req(reader.token), "write", {})) as Response).status, 404);
    assert.equal(((await authorize(harness.db, req(), "write", WRITE)) as Response).status, 401);
    assert.equal(((await authorize(harness.db, req(reader.token), "write", WRITE)) as Response).status, 403);
    const ok = await authorize(harness.db, req(reader.token), "read", WRITE);
    assert.ok(!(ok instanceof Response));
    assert.equal(ok.tenantId, "bw-http");
  } finally {
    await harness.close();
  }
});

// --- IDLE ----------------------------------------------------------------------------------------

test("IDLE returns at once when the folder has already moved past the client's modseq", async () => {
  const harness = await mailbox("bw-idle1");
  try {
    await placed(harness, "bw-idle1", "m1", "inbox");
    const result = await waitForChange(harness.db, "bw-idle1", "inbox", 0, { env: READ_ONLY, sleep: async () => assert.fail("should not wait") });
    assert.equal(result.changed, true);
    assert.ok(result.modseq > 0);
  } finally {
    await harness.close();
  }
});

test("IDLE wakes when new mail arrives while it waits", async () => {
  const harness = await mailbox("bw-idle2");
  try {
    const start = (await folderState(harness.db, "bw-idle2", "inbox")).modseq;
    let polls = 0;
    const result = await waitForChange(harness.db, "bw-idle2", "inbox", start, {
      env: READ_ONLY,
      intervalMs: 50,
      // The second poll finds new mail, written the way inbound mail is.
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          await insertMessage(harness.db, "bw-idle2", message("arrived", "inbox"), null);
          await noteNewMessage(harness.db, "bw-idle2", "inbox", "arrived", { env: READ_ONLY });
        }
      },
    });
    assert.equal(result.changed, true);
    const rows = await changesSince(harness.db, "bw-idle2", "inbox", start, 10);
    assert.deepEqual(rows.map((r) => r.messageId), ["arrived"]);
  } finally {
    await harness.close();
  }
});

test("IDLE times out with changed=false, and gives up early when the client disconnects", async () => {
  const harness = await mailbox("bw-idle3");
  try {
    let now = 0;
    const quiet = await waitForChange(harness.db, "bw-idle3", "inbox", 0, {
      env: { ...READ_ONLY, MAIL_BRIDGE_IDLE_SECONDS: "2" },
      intervalMs: 500,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.deepEqual(quiet, { folder: "inbox", changed: false, modseq: 0 });
    assert.ok(now <= 2000, "never waits past the deadline");

    const controller = new AbortController();
    controller.abort();
    const gone = await waitForChange(harness.db, "bw-idle3", "inbox", 0, { env: READ_ONLY, signal: controller.signal, sleep: async () => assert.fail("should not wait") });
    assert.equal(gone.changed, false);
  } finally {
    await harness.close();
  }
});

test("inbound mail gets its UID at once when the bridge is on, and writes no bridge row when off", async () => {
  const saved = process.env.MAIL_BRIDGE;
  const harness = await mailbox("bw-inbound");
  const raw = (subject: string) => new TextEncoder().encode(["From: Leah <leah@example.org>", "To: Ada <bw-inbound@cumuluscloud.app>", `Subject: ${subject}`, "Content-Type: text/plain", "", "Hello"].join("\r\n"));
  try {
    delete process.env.MAIL_BRIDGE;
    await ingestInboundEmail(harness.db, harness.storageFor, { from: "leah@example.org", to: "bw-inbound@cumuluscloud.app", raw: raw("off") });
    assert.deepEqual(await harness.db.query(`select 1 from cumulus_mail.message_uids where tenant_id = 'bw-inbound'`), []);
    process.env.MAIL_BRIDGE = "on";
    const { stored } = await ingestInboundEmail(harness.db, harness.storageFor, { from: "leah@example.org", to: "bw-inbound@cumuluscloud.app", raw: raw("on") });
    const rows = await changesSince(harness.db, "bw-inbound", "inbox", 0, 10);
    assert.deepEqual(rows.map((r) => r.messageId), stored);
  } finally {
    if (saved === undefined) delete process.env.MAIL_BRIDGE;
    else process.env.MAIL_BRIDGE = saved;
    await harness.close();
  }
});

// --- MOVE ----------------------------------------------------------------------------------------

test("MOVE moves the messages, expunges the old UIDs and returns COPYUID pairs", async () => {
  const harness = await mailbox("bw-move");
  try {
    const u1 = await placed(harness, "bw-move", "m1", "inbox");
    const u2 = await placed(harness, "bw-move", "m2", "inbox");
    await placed(harness, "bw-move", "m3", "inbox");
    const before = (await folderState(harness.db, "bw-move", "inbox")).modseq;

    const result = await moveMessages(harness.db, "bw-move", { from: "inbox", to: "archive", uids: [u1, u2, 9999] });
    const archive = await folderState(harness.db, "bw-move", "archive");
    assert.equal(result.uidvalidity, archive.uidvalidity);
    assert.deepEqual(result.moved.map(([from]) => from), [u1, u2], "a UID not in the folder is skipped");
    assert.deepEqual(result.moved.map(([, to]) => to), [1, 2], "new UIDs in the destination");
    assert.equal(await folderOf(harness, "bw-move", "m1"), "archive");
    assert.equal(await folderOf(harness, "bw-move", "m3"), "inbox", "untouched");

    const inbox = await changesSince(harness.db, "bw-move", "inbox", before, 10);
    assert.deepEqual(inbox.map((r) => [r.uid, r.expunged]), [[u1, true], [u2, true]]);
    // Moving again is a no-op: the old UIDs are expunged.
    assert.deepEqual((await moveMessages(harness.db, "bw-move", { from: "inbox", to: "archive", uids: [u1] })).moved, []);
  } finally {
    await harness.close();
  }
});

test("MOVE refuses Drafts and Quarantine, unknown folders, and leaves a message the app moved meanwhile", async () => {
  const harness = await mailbox("bw-move2");
  try {
    const u = await placed(harness, "bw-move2", "m1", "inbox");
    const q = await placed(harness, "bw-move2", "q1", "quarantine");
    for (const [from, to, code] of [
      ["inbox", "drafts", "not_allowed"],
      ["inbox", "quarantine", "not_allowed"],
      ["quarantine", "inbox", "not_allowed"],
      ["inbox", "folder-nope", "bad_folder"],
      ["inbox", "receipts", "bad_folder"],
    ] as const) {
      await assert.rejects(
        () => moveMessages(harness.db, "bw-move2", { from, to, uids: [u, q] }),
        (e: unknown) => e instanceof BridgeWriteError && e.code === code,
        `${from} -> ${to}`,
      );
    }
    // A custom folder that exists is a valid target.
    const settings = await readSettings(harness.db, "bw-move2");
    await writeSettings(harness.db, "bw-move2", { ...settings, folders: [{ id: "folder-receipts", name: "Receipts" }] });
    // The app moved m1 to Trash after the bridge last synced: the bridge's MOVE skips it.
    await harness.db.query(`update cumulus_mail.messages set folder = 'trash' where tenant_id = 'bw-move2' and id = 'm1'`);
    const result = await moveMessages(harness.db, "bw-move2", { from: "inbox", to: "folder-receipts", uids: [u] });
    assert.deepEqual(result.moved, []);
    assert.equal(await folderOf(harness, "bw-move2", "m1"), "trash");
  } finally {
    await harness.close();
  }
});

// --- APPEND --------------------------------------------------------------------------------------

test("APPEND files a sent copy, sealed, with its UID; the same bytes twice give the same UID", async () => {
  const harness = await mailbox("bw-append");
  try {
    const raw = rfc822("bw-append@cumuluscloud.app", "Quarterly");
    const first = await appendSentCopy(harness.db, harness.storageFor, "bw-append", { folder: "sent", raw }, { env: WRITE });
    assert.equal(first.duplicate, false);
    assert.equal(first.uid, 1);
    assert.equal(first.uidvalidity, (await folderState(harness.db, "bw-append", "sent")).uidvalidity);
    const row = (await harness.db.query<{ folder: string; unread: boolean; subject: string; raw_key: string | null }>(
      `select folder, unread, subject, raw_key from cumulus_mail.messages where tenant_id = 'bw-append' and id = $1`,
      [first.messageId],
    ))[0]!;
    assert.equal(row.folder, "sent");
    assert.equal(row.unread, false, "a sent copy is \\Seen");
    assert.equal(row.subject.includes("Quarterly"), false, "stored sealed");
    const blob = await harness.storageFor("bw-append").get(row.raw_key!);
    assert.equal(blob?.body.byteLength, raw.byteLength, "the raw message is kept for BODY[] later");

    const again = await appendSentCopy(harness.db, harness.storageFor, "bw-append", { folder: "sent", raw }, { env: WRITE });
    assert.deepEqual({ uid: again.uid, duplicate: again.duplicate, id: again.messageId }, { uid: 1, duplicate: true, id: first.messageId });
  } finally {
    await harness.close();
  }
});

test("APPEND refuses other folders, other people's From, oversize and full mailboxes", async () => {
  const harness = await mailbox("bw-append2");
  try {
    const own = rfc822("bw-append2@cumuluscloud.app", "Mine");
    const reject = (fn: () => Promise<unknown>, code: string) =>
      assert.rejects(fn, (e: unknown) => e instanceof BridgeWriteError && e.code === code, code);
    await reject(() => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "inbox", raw: own }, { env: WRITE }), "not_allowed");
    await reject(() => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "drafts", raw: own }, { env: WRITE }), "not_allowed");
    await reject(
      () => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "sent", raw: rfc822("ceo@bank.example", "Wire") }, { env: WRITE }),
      "not_own_address",
    );
    await reject(
      () => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "sent", raw: own }, { env: { ...WRITE, MAIL_BRIDGE_APPEND_BYTES: "10" } }),
      "too_large",
    );
    await reject(() => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "sent", raw: new Uint8Array() }, { env: WRITE }), "bad_message");
    // Fill the mailbox past any plan's quota with recorded (not stored) 2 GB attachments.
    await insertMessage(harness.db, "bw-append2", message("big", "inbox"), null);
    for (let i = 0; i < 30; i += 1) {
      await insertAttachment(harness.db, "bw-append2", "big", { id: `a-big-${i}`, name: "big.bin", size: 2_000_000_000, contentType: "application/octet-stream", sha256: "0".repeat(64), objectKey: "0".repeat(32) });
    }
    await reject(
      () => appendSentCopy(harness.db, harness.storageFor, "bw-append2", { folder: "sent", raw: own }, { env: WRITE, enforceStorage: true }),
      "mailbox_full",
    );
    assert.deepEqual(await harness.db.query(`select 1 from cumulus_mail.messages where tenant_id = 'bw-append2' and folder = 'sent' and id like 'ap-%'`), []);
  } finally {
    await harness.close();
  }
});
