import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHarness } from "../test-support.ts";
import { bridgeEnabled, bridgeLimits, DEFAULT_LIMITS, READ_SCOPE } from "./config.ts";
import { BridgeOffError, TooManyTokensError, checkToken, createToken, listTokens, newTokenValue, revokeToken, tokenHash } from "./tokens.ts";
import { rateCheck, resetRateLimits, syncFolder } from "./sync.ts";
import { changesSince, expungeMessage, folderState, syncUidsForMailbox, touchMessage } from "./uids.ts";

const ON = { MAIL_BRIDGE: "on", MAIL_BLOB_KEY: process.env.MAIL_BLOB_KEY };
const TENANT = "bridge-test";

afterEach(() => resetRateLimits());

async function harnessWithMailbox() {
  const harness = await createHarness();
  await harness.db.query(
    `insert into cumulus_mail.mailboxes (tenant_id, address, display_name, cid, plan, quota_gb)
     values ($1, 'sealed', 'sealed', 'cid:bridge', 'Free', 15)`,
    [TENANT],
  );
  return harness;
}

test("the bridge is off unless MAIL_BRIDGE=on, and off means no token can be made", async () => {
  assert.equal(bridgeEnabled({}), false);
  assert.equal(bridgeEnabled({ MAIL_BRIDGE: "true" }), false);
  assert.equal(bridgeEnabled({ MAIL_BRIDGE: " ON " }), true);
  const harness = await harnessWithMailbox();
  try {
    await assert.rejects(() => createToken(harness.db, TENANT, "Thunderbird", { env: {} }), BridgeOffError);
    assert.deepEqual(await harness.db.query(`select 1 from cumulus_mail.bridge_tokens`), []);
  } finally {
    await harness.close();
  }
});

test("a token is stored only as a hash, is read-only, and authenticates its own mailbox", async () => {
  const harness = await harnessWithMailbox();
  try {
    const { token, record } = await createToken(harness.db, TENANT, "Thunderbird", { env: ON });
    assert.match(token, /^cmb_[A-Za-z0-9_-]{20,}$/);
    assert.equal(record.scope, READ_SCOPE);
    const stored = await harness.db.query<{ token_sha256: string; name_enc: string; scope: string }>(
      `select token_sha256, name_enc, scope from cumulus_mail.bridge_tokens where tenant_id = $1`,
      [TENANT],
    );
    assert.equal(stored[0]?.token_sha256, tokenHash(token));
    assert.equal(stored[0]?.token_sha256.includes(token), false, "the token itself must not be stored");
    assert.equal(stored[0]?.name_enc.includes("Thunderbird"), false, "the name is ciphertext");
    assert.equal(stored[0]?.scope, READ_SCOPE);

    const who = await checkToken(harness.db, `Bearer ${token}`, { env: ON });
    assert.deepEqual(who, { ok: true, tenantId: TENANT, id: record.id, scope: READ_SCOPE });
    const used = await harness.db.query<{ last_used_at: string | Date | null }>(
      `select last_used_at from cumulus_mail.bridge_tokens where tenant_id = $1`,
      [TENANT],
    );
    assert.notEqual(used[0]?.last_used_at, null, "a use is recorded");
  } finally {
    await harness.close();
  }
});

test("a wrong, malformed or revoked token is refused, and so is every token while the bridge is off", async () => {
  const harness = await harnessWithMailbox();
  try {
    const { token, record } = await createToken(harness.db, TENANT, "Mail.app", { env: ON });
    assert.deepEqual(await checkToken(harness.db, `Bearer ${token}`, { env: {} }), { ok: false, reason: "off" });
    assert.deepEqual(await checkToken(harness.db, null, { env: ON }), { ok: false, reason: "malformed" });
    assert.deepEqual(await checkToken(harness.db, "Bearer not-a-token", { env: ON }), { ok: false, reason: "malformed" });
    assert.deepEqual(await checkToken(harness.db, `Bearer ${newTokenValue()}`, { env: ON }), { ok: false, reason: "unknown" });
    assert.equal(await revokeToken(harness.db, TENANT, record.id), true);
    assert.deepEqual(await checkToken(harness.db, `Bearer ${token}`, { env: ON }), { ok: false, reason: "revoked" });
    assert.equal(await revokeToken(harness.db, TENANT, record.id), false, "revoking twice changes nothing");
    assert.equal(await revokeToken(harness.db, "someone-else", record.id), false, "another mailbox cannot revoke it");
    assert.deepEqual(await listTokens(harness.db, TENANT), []);
  } finally {
    await harness.close();
  }
});

test("a mailbox may hold only so many tokens at once; revoking frees a slot", async () => {
  const harness = await harnessWithMailbox();
  const limits = { ...DEFAULT_LIMITS, tokens: 2 };
  try {
    const first = await createToken(harness.db, TENANT, "one", { env: ON, limits });
    await createToken(harness.db, TENANT, "two", { env: ON, limits });
    await assert.rejects(() => createToken(harness.db, TENANT, "three", { env: ON, limits }), TooManyTokensError);
    await revokeToken(harness.db, TENANT, first.record.id);
    await createToken(harness.db, TENANT, "three", { env: ON, limits });
    assert.equal((await listTokens(harness.db, TENANT)).length, 2);
  } finally {
    await harness.close();
  }
});

test("UIDs: assigned once, never reused, and a move expunges the old folder's UID", async () => {
  const harness = await harnessWithMailbox();
  try {
    const first = await touchMessage(harness.db, TENANT, "inbox", "m1");
    const second = await touchMessage(harness.db, TENANT, "inbox", "m2");
    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(await touchMessage(harness.db, TENANT, "inbox", "m1"), 1, "the same message keeps its UID");

    // Moved to archive: a new UID there, and expunged from the inbox. UID 1 is never handed out again.
    await expungeMessage(harness.db, TENANT, "inbox", "m1");
    assert.equal(await touchMessage(harness.db, TENANT, "archive", "m1"), 1, "each folder numbers from 1");
    assert.equal(await touchMessage(harness.db, TENANT, "inbox", "m3"), 3, "the inbox does not reuse UID 1");

    const inbox = await folderState(harness.db, TENANT, "inbox");
    assert.equal(inbox.uidNext, 4);
    assert.ok(inbox.uidvalidity > 0);
    assert.equal((await folderState(harness.db, TENANT, "inbox")).uidvalidity, inbox.uidvalidity, "uidvalidity is stable");
  } finally {
    await harness.close();
  }
});

test("sync: modseq only moves forward, reports expunges, and pages without skipping a row", async () => {
  const harness = await harnessWithMailbox();
  try {
    for (const id of ["m1", "m2", "m3"]) await touchMessage(harness.db, TENANT, "inbox", id);
    const all = await syncFolder(harness.db, TENANT, { folder: "inbox" }, { env: ON });
    assert.deepEqual(all.changes.map((c) => c.messageId), ["m1", "m2", "m3"]);
    assert.equal(all.more, false);
    assert.ok(all.uidvalidity > 0);

    // Nothing has changed since: no rows, and the caller's modseq is handed back.
    const quiet = await syncFolder(harness.db, TENANT, { folder: "inbox", sinceModseq: all.modseq }, { env: ON });
    assert.deepEqual(quiet.changes, []);
    assert.equal(quiet.modseq, all.modseq);

    await expungeMessage(harness.db, TENANT, "inbox", "m2");
    const afterDelete = await syncFolder(harness.db, TENANT, { folder: "inbox", sinceModseq: all.modseq }, { env: ON });
    assert.deepEqual(afterDelete.changes.map((c) => [c.messageId, c.expunged]), [["m2", true]]);
    assert.ok(afterDelete.modseq > all.modseq);

    // Paging: one row at a time from 0 reaches every row exactly once, in modseq order.
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i += 1) {
      const page = await syncFolder(harness.db, TENANT, { folder: "inbox", sinceModseq: cursor, limit: 1 }, { env: ON });
      if (page.changes.length === 0) break;
      seen.push(...page.changes.map((c) => c.messageId));
      cursor = page.modseq;
    }
    assert.deepEqual(seen, ["m1", "m3", "m2"], "each row once, oldest change first");
  } finally {
    await harness.close();
  }
});

test("changesSince and syncFolder never return another mailbox's rows", async () => {
  const harness = await harnessWithMailbox();
  try {
    await harness.db.query(
      `insert into cumulus_mail.mailboxes (tenant_id, address, display_name, cid, plan, quota_gb)
       values ('other-tenant', 'sealed', 'sealed', 'cid:other', 'Free', 15)`,
    );
    await touchMessage(harness.db, TENANT, "inbox", "mine");
    await touchMessage(harness.db, "other-tenant", "inbox", "theirs");
    assert.deepEqual((await changesSince(harness.db, TENANT, "inbox", 0, 50)).map((r) => r.messageId), ["mine"]);
    const report = await syncFolder(harness.db, "other-tenant", { folder: "inbox" }, { env: ON });
    assert.deepEqual(report.changes.map((c) => c.messageId), ["theirs"]);
  } finally {
    await harness.close();
  }
});

test("syncUidsForMailbox writes nothing while the bridge is off, and reconciles a snapshot when on", async () => {
  const harness = await harnessWithMailbox();
  try {
    const snapshot = [
      { id: "a", folder: "inbox" },
      { id: "b", folder: "inbox" },
    ];
    await syncUidsForMailbox(harness.db, TENANT, snapshot, { env: {} });
    assert.deepEqual(await harness.db.query(`select 1 from cumulus_mail.message_uids`), []);

    await syncUidsForMailbox(harness.db, TENANT, snapshot, { env: ON });
    assert.deepEqual((await changesSince(harness.db, TENANT, "inbox", 0, 50)).map((r) => [r.messageId, r.expunged]), [["a", false], ["b", false]]);

    // "b" moved to archive and "c" arrived: b is expunged from the inbox, keeps a fresh UID in archive.
    await syncUidsForMailbox(harness.db, TENANT, [
      { id: "a", folder: "inbox" },
      { id: "b", folder: "archive" },
      { id: "c", folder: "inbox" },
    ], { env: ON });
    const inbox = await changesSince(harness.db, TENANT, "inbox", 0, 50);
    assert.deepEqual(inbox.filter((r) => !r.expunged).map((r) => r.messageId).sort(), ["a", "c"]);
    assert.deepEqual(inbox.filter((r) => r.expunged).map((r) => r.messageId), ["b"]);
    assert.deepEqual((await changesSince(harness.db, TENANT, "archive", 0, 50)).map((r) => r.messageId), ["b"]);
  } finally {
    await harness.close();
  }
});

test("rate limit: a token gets so many calls a minute, then a Retry-After, and the window reopens", () => {
  const limits = { ...DEFAULT_LIMITS, perMinute: 3 };
  const start = 1_000_000;
  assert.deepEqual(rateCheck("t1", { limits, now: start }), { allowed: true, remaining: 2, retryAfterSeconds: 0 });
  rateCheck("t1", { limits, now: start + 1 });
  rateCheck("t1", { limits, now: start + 2 });
  const blocked = rateCheck("t1", { limits, now: start + 3 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
  // Another token has its own window, and the first one's reopens after a minute.
  assert.equal(rateCheck("t2", { limits, now: start + 3 }).allowed, true);
  assert.equal(rateCheck("t1", { limits, now: start + 61_000 }).allowed, true);
});

test("limits come from the environment, within bounds", () => {
  assert.deepEqual(bridgeLimits({}), DEFAULT_LIMITS);
  assert.deepEqual(bridgeLimits({ MAIL_BRIDGE_MAX_TOKENS: "3", MAIL_BRIDGE_RATE_PER_MINUTE: "10", MAIL_BRIDGE_PAGE_SIZE: "50" }), { tokens: 3, perMinute: 10, pageSize: 50 });
  assert.deepEqual(bridgeLimits({ MAIL_BRIDGE_MAX_TOKENS: "0", MAIL_BRIDGE_PAGE_SIZE: "-5" }), DEFAULT_LIMITS);
  assert.equal(bridgeLimits({ MAIL_BRIDGE_PAGE_SIZE: "99999" }).pageSize, 1_000);
});
