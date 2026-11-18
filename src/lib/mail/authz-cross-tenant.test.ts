/**
 * Cross-tenant authorization sweep, in-process: tenant B, holding every id of tenant A's (message,
 * attachment, share), tries each operation a signed-in person can ask for. Every one must refuse or find
 * nothing, and A's data must be unchanged afterwards.
 *
 * The session functions (src/lib/mail/mailbox.server.ts) resolve the tenant from the session and pass it to
 * the functions tested here (src/lib/security.test.ts checks that wiring); `scripts/authz-sweep.mjs` checks
 * over HTTP that nothing answers without a session.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { reportedMessage } from "./spam.ts";
import { unsubscribeMessage } from "./unsubscribe.ts";
import { issueBlobShare, openBlobShare, sqlShareLedger } from "./share.ts";
import { createHarness, profile } from "./test-support.ts";
import { bytesToBase64 } from "./bytes.ts";
import type { MailMessage } from "./model.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const A = "authz-alice";
const B = "authz-bob";
const masterKey = randomBytes(32);

function letter(id: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: id,
    folder: "inbox",
    from: { name: "News", email: "news@shop.example" },
    to: [{ name: "Alice", email: `${A}@cumuluscloud.app` }],
    cc: [],
    subject: "Alice private subject",
    body: "alice secret words zebracorn",
    at: "2026-11-18T09:00:00.000Z",
    unread: true,
    starred: false,
    labels: [],
    headers: { "List-Unsubscribe": "<https://shop.example/u/alice>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    ...extra,
  };
}

test("tenant B cannot read, report, unsubscribe, search, share or revoke anything of tenant A's", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, A, profile(A, `${A}@cumuluscloud.app`, "Alice"));
  await openMailbox(db, B, profile(B, `${B}@cumuluscloud.app`, "Bob"));
  const file = { id: "att-alice", name: "contract.pdf", size: 6, contentType: "application/pdf", dataBase64: bytesToBase64(new TextEncoder().encode("secret")) };
  const savedA = await writeSnapshot(db, storageFor, A, {
    ...(await readSnapshot(db, A)),
    messages: [letter("msg-alice", { attachments: [file] })],
  });
  const message = savedA.messages[0]!;
  const attachmentId = message.attachments![0]!.id!;
  assert.ok(await readAttachment(db, storageFor(A), A, message.id, attachmentId), "A can read her own attachment");

  // Read an attachment by A's ids.
  assert.equal(await readAttachment(db, storageFor(B), B, message.id, attachmentId), null);

  // Report spam on A's message (would cast a vote from B's mailbox on A's sender).
  assert.equal(await reportedMessage(db, B, message.id), null);

  // One-click unsubscribe using A's message (would POST to A's unsubscribe URL).
  let fetched = 0;
  await assert.rejects(
    unsubscribeMessage(db, B, message.id, async () => {
      fetched += 1;
      return new Response("ok");
    }),
    /gone/,
  );
  assert.equal(fetched, 0, "nothing was sent to A's sender");

  // Search for A's words from B's mailbox.
  const { searchMessages } = await import("./search.ts");
  assert.equal((await searchMessages(db, A, "zebracorn")).hits.length, 1, "A finds her own message");
  assert.equal((await searchMessages(db, B, "zebracorn")).hits.length, 0);

  // Share A's attachment from B's mailbox, by its stored blob id.
  const blob = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1 and id = $2`,
    [A, attachmentId],
  );
  const blobId = blob[0]!.object_key;
  await assert.rejects(issueBlobShare(db, B, blobId, 60_000, masterKey), /not found/i);

  // Revoke A's share link from B's mailbox: A's link keeps working.
  const share = await issueBlobShare(db, A, blobId, 60_000, masterKey);
  const jti = (await db.query<{ jti: string }>(`select jti from cumulus_mail.share_grants where tenant_id = $1`, [A]))[0]!.jti;
  await sqlShareLedger(db).revoke(jti, B);
  assert.equal(await sqlShareLedger(db).status(jti), "active");
  const opened = await openBlobShare(db, async (tenant, id) => (await storageFor(tenant).get(id))?.body ?? null, share.token, masterKey);
  assert.equal(opened.tenantId, A);

  // B saves a snapshot that claims A's message id: it lands in B's mailbox only; A's copy is untouched.
  const bSnapshot = await readSnapshot(db, B);
  await writeSnapshot(db, storageFor, B, {
    ...bSnapshot,
    messages: [letter("msg-alice", { subject: "overwritten by bob", attachments: [{ id: attachmentId, name: "x", size: 1 }] })],
    knownIds: ["msg-alice"],
  });
  const afterA = await readSnapshot(db, A);
  assert.equal(afterA.messages[0]?.subject, "Alice private subject");
  const bobsCopy = (await readSnapshot(db, B)).messages[0];
  assert.equal(bobsCopy?.attachments?.[0]?.id, undefined, "B cannot attach A's stored file by naming its id");
  assert.ok(await readAttachment(db, storageFor(A), A, message.id, attachmentId), "A's attachment still opens");
});
