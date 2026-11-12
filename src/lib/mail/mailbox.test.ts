import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TenantAccessError } from "../storage/adapter.ts";
import { findTenantByAddress } from "./directory.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { rejectCallerTenant } from "./snapshot.ts";
import { readSnapshot, replaceMailboxContents } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";
import type { MailMessage } from "./model.ts";
import { bytesToBase64 } from "./bytes.ts";
import { checksumOf } from "../storage/adapter.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

function letter(partial: Partial<MailMessage> & Pick<MailMessage, "id" | "folder">): MailMessage {
  return {
    threadId: partial.threadId ?? partial.id,
    from: partial.from ?? { name: "Ada", email: "ada@cumuluscloud.app" },
    to: partial.to ?? [{ name: "Bea", email: "bea@cumuluscloud.app" }],
    cc: partial.cc ?? [],
    subject: partial.subject ?? "Hello",
    body: partial.body ?? "secret body",
    at: partial.at ?? "2026-11-07T12:00:00.000Z",
    unread: partial.unread ?? false,
    starred: partial.starred ?? false,
    labels: partial.labels ?? [],
    attachments: partial.attachments,
    delivery: partial.delivery,
    ...partial,
  };
}

test("a caller-supplied tenant id is rejected", () => {
  assert.throws(() => rejectCallerTenant({ tenantId: "other", messages: [] }), TenantAccessError);
  assert.throws(() => rejectCallerTenant({ tenant: "other" }), TenantAccessError);
  assert.doesNotThrow(() => rejectCallerTenant({ messages: [] }));
});

test("mail and blobs for one tenant are invisible to another", async () => {
  const { db, storageFor } = harness;
  const ada = profile("tenant-ada", "ada@cumuluscloud.app", "Ada");
  const bea = profile("tenant-bea", "bea@cumuluscloud.app", "Bea");
  await openMailbox(db, "tenant-ada", ada);
  await openMailbox(db, "tenant-bea", bea);
  const payload = new TextEncoder().encode("only ada");
  const saved = await writeSnapshot(db, storageFor, "tenant-ada", {
    me: ada,
    messages: [
      letter({
        id: "m-ada-1",
        folder: "inbox",
        from: { name: "Bea", email: "bea@cumuluscloud.app" },
        to: [{ name: "Ada", email: "ada@cumuluscloud.app" }],
        attachments: [
          {
            name: "note.txt",
            size: payload.byteLength,
            contentType: "text/plain",
            dataBase64: bytesToBase64(payload),
          },
        ],
      }),
    ],
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "Ada",
    rules: [],
  });
  const file = saved.messages[0]?.attachments?.[0];
  assert.ok(file?.id);
  assert.equal(file?.sha256, await checksumOf(payload));
  const adaBytes = await readAttachment(db, storageFor("tenant-ada"), "tenant-ada", "m-ada-1", file.id);
  assert.equal(new TextDecoder().decode(adaBytes?.bytes), "only ada");

  const beaView = await openMailbox(db, "tenant-bea", bea);
  assert.equal(beaView.messages.some((message) => message.id === "m-ada-1"), false);
  assert.equal(await readAttachment(db, storageFor("tenant-bea"), "tenant-bea", "m-ada-1", file.id), null);
  const adaBlobs = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1`,
    ["tenant-ada"],
  );
  assert.equal(await storageFor("tenant-bea").get(adaBlobs[0]?.object_key ?? ""), null);

  await assert.rejects(
    () => writeSnapshot(db, storageFor, "tenant-bea", { ...beaView, aliases: ["ada@cumuluscloud.app"] }),
    TenantAccessError,
  );
});

test("the preview mailbox is seeded once and keeps its address", async () => {
  const { db } = harness;
  const first = await openMailbox(db, "dev-user", profile("dev-user", "alex@cumuluscloud.app", "Alex Reid"));
  assert.equal(first.me.email, "alex@cumuluscloud.app");
  assert.equal(first.messages.some((message) => message.id === "m-leah-1"), true);
  assert.equal(await findTenantByAddress(db, "leah@cumuluscloud.app"), "demo-leah");
  const second = await openMailbox(db, "dev-user", profile("dev-user", "alex@cumuluscloud.app", "Alex Reid"));
  assert.equal(second.messages.length, first.messages.length);
});

test("the server enforces the address limit, but keeps mailboxes that already went over it", async () => {
  const { MAX_ALIASES } = await import("./model.ts");
  const harness = await createHarness();
  try {
    const me = profile("alias-cap", "cap@cumuluscloud.app", "Cap");
    await openMailbox(harness.db, "alias-cap", me);
    const base = await readSnapshot(harness.db, "alias-cap");
    const many = (n: number) => Array.from({ length: n }, (_, index) => `cap.alias${index}@cumuluscloud.app`);
    const saved = await writeSnapshot(harness.db, harness.storageFor, "alias-cap", { ...base, aliases: many(MAX_ALIASES) });
    assert.equal(saved.aliases.length, MAX_ALIASES);
    await assert.rejects(
      () => writeSnapshot(harness.db, harness.storageFor, "alias-cap", { ...saved, aliases: many(MAX_ALIASES + 1) }),
      /up to 15 addresses/,
    );
    assert.equal((await readSnapshot(harness.db, "alias-cap")).aliases.length, MAX_ALIASES);
    // Duplicates and the mailbox's own address do not count toward the limit.
    const dupes = [...many(MAX_ALIASES), "CAP.ALIAS0@cumuluscloud.app", me.email];
    assert.equal((await writeSnapshot(harness.db, harness.storageFor, "alias-cap", { ...saved, aliases: dupes })).aliases.length, MAX_ALIASES);

    // A mailbox stored with more than the limit before this check existed can still save, but not grow.
    const over = await readSnapshot(harness.db, "alias-cap");
    await replaceMailboxContents(harness.db, "alias-cap", { ...over, aliases: many(MAX_ALIASES + 2) }, [], new Map());
    const legacy = await readSnapshot(harness.db, "alias-cap");
    assert.equal(legacy.aliases.length, MAX_ALIASES + 2);
    const resaved = await writeSnapshot(harness.db, harness.storageFor, "alias-cap", { ...legacy, signature: "still works" });
    assert.equal(resaved.aliases.length, MAX_ALIASES + 2);
    await assert.rejects(
      () => writeSnapshot(harness.db, harness.storageFor, "alias-cap", { ...legacy, aliases: many(MAX_ALIASES + 3) }),
      /up to 15 addresses/,
    );
  } finally {
    await harness.close();
  }
});
