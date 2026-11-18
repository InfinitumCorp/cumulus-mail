import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TenantAccessError } from "../storage/adapter.ts";
import { findTenantByAddress } from "./directory.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { rejectCallerTenant } from "./snapshot.ts";
import { insertAttachment, insertMessage, readSnapshot, replaceMailboxContents } from "./records.ts";
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

test("the server refuses a fourth custom domain instead of silently dropping it", async () => {
  const { MAX_DOMAINS, defaultSettings, requestedDomainCount } = await import("./settings.ts");
  const { readSnapshot } = await import("./records.ts");
  const harness = await createHarness();
  try {
    const me = profile("dom-cap", "domcap@cumuluscloud.app", "Dom");
    await openMailbox(harness.db, "dom-cap", me);
    const base = await readSnapshot(harness.db, "dom-cap");
    const domain = (name: string) => ({ domain: name, catchAll: false, verified: false, txtName: "", txtValue: "" });
    const three = ["a.example", "b.example", "c.example"].map(domain);
    const saved = await writeSnapshot(harness.db, harness.storageFor, "dom-cap", { ...base, settings: { ...defaultSettings(), domains: three } });
    assert.equal(saved.settings?.domains.length, MAX_DOMAINS);
    await assert.rejects(
      () => writeSnapshot(harness.db, harness.storageFor, "dom-cap", { ...saved, settings: { ...saved.settings!, domains: [...three, domain("d.example")] } }),
      /up to 3 custom domains/,
    );
    assert.equal((await readSnapshot(harness.db, "dom-cap")).settings?.domains.length, 3);
    // Duplicates, invalid names and the platform domain do not count.
    assert.equal(requestedDomainCount({ domains: [...three, domain("A.EXAMPLE"), domain("not a domain"), domain("cumuluscloud.app")] }), 3);
    // Removing one makes room again.
    const fewer = await writeSnapshot(harness.db, harness.storageFor, "dom-cap", { ...saved, settings: { ...saved.settings!, domains: three.slice(1) } });
    assert.deepEqual(fewer.settings?.domains.map((item) => item.domain), ["b.example", "c.example"]);
  } finally {
    await harness.close();
  }
});

test("a save never deletes mail the client did not know about (it arrived after the tab loaded)", async () => {
  const { db, storageFor } = harness;
  const tenant = "save-keeps-new";
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  await writeSnapshot(db, storageFor, tenant, { ...(await readSnapshot(db, tenant)), messages: [letter({ id: "old-1", folder: "inbox" }), letter({ id: "old-2", folder: "inbox" })] });

  // The tab loads the mailbox...
  const loaded = await readSnapshot(db, tenant);
  const knownIds = loaded.messages.map((m) => m.id);

  // ...then new mail arrives on the server, with its raw message and an attachment.
  const storage = storageFor(tenant);
  const raw = await storage.put(new TextEncoder().encode("From: x@example.com\r\n\r\nnew mail"));
  const file = await storage.put(new TextEncoder().encode("attached"));
  await insertMessage(db, tenant, letter({ id: "arrived", folder: "inbox", subject: "Arrived meanwhile", unread: true }), raw.blobId);
  await insertAttachment(db, tenant, "arrived", { id: "att-arrived", name: "a.txt", size: 8, contentType: "text/plain", sha256: file.sha256, objectKey: file.blobId });

  // The person stars a message in the stale tab: the save keeps the new mail, its raw message and file.
  const starred = loaded.messages.map((m) => (m.id === "old-1" ? { ...m, starred: true } : m));
  const saved = await writeSnapshot(db, storageFor, tenant, { ...loaded, messages: starred, knownIds });
  const ids = saved.messages.map((m) => m.id).sort();
  assert.deepEqual(ids, ["arrived", "old-1", "old-2"]);
  assert.equal(saved.messages.find((m) => m.id === "old-1")?.starred, true);
  const arrived = saved.messages.find((m) => m.id === "arrived");
  assert.equal(arrived?.subject, "Arrived meanwhile");
  assert.equal(arrived?.attachments?.[0]?.name, "a.txt");
  assert.ok(await storage.get(raw.blobId), "the raw message is still stored");
  assert.ok(await readAttachment(db, storage, tenant, "arrived", "att-arrived"), "the attachment still opens");

  // Deleting a message the client knew about still deletes it.
  const after = saved.messages.filter((m) => m.id !== "old-2");
  const again = await writeSnapshot(db, storageFor, tenant, { ...saved, messages: after, knownIds: saved.messages.map((m) => m.id) });
  assert.deepEqual(again.messages.map((m) => m.id).sort(), ["arrived", "old-1"]);

  // A client that has not loaded yet (knownIds empty) cannot delete anything.
  const blindSave = await writeSnapshot(db, storageFor, tenant, { ...again, messages: [], knownIds: [] });
  assert.deepEqual(blindSave.messages.map((m) => m.id).sort(), ["arrived", "old-1"]);
});

test("an older client without knownIds still replaces the mailbox (unchanged behaviour)", async () => {
  const { db, storageFor } = harness;
  const tenant = "save-legacy";
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  await writeSnapshot(db, storageFor, tenant, { ...(await readSnapshot(db, tenant)), messages: [letter({ id: "keep", folder: "inbox" }), letter({ id: "drop", folder: "inbox" })] });
  const loaded = await readSnapshot(db, tenant);
  const saved = await writeSnapshot(db, storageFor, tenant, { ...loaded, messages: loaded.messages.filter((m) => m.id !== "drop") });
  assert.deepEqual(saved.messages.map((m) => m.id), ["keep"]);
});

test("a stale tab's save keeps the auto-reply history and unsubscribes the server recorded meanwhile", async () => {
  const { db, storageFor } = harness;
  const { readSettings, writeSettings } = await import("./records.ts");
  const { keepServerNotes, noteAutoReply, noteUnsubscribed } = await import("./settings.ts");
  const tenant = "save-keeps-notes";
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  const loaded = await readSnapshot(db, tenant);

  // While the tab is open, the server sends an auto-reply and records a one-click unsubscribe.
  const now = new Date("2026-11-17T09:00:00Z");
  await writeSettings(db, tenant, noteUnsubscribed(noteAutoReply(await readSettings(db, tenant), "bob@example.com", now), "news@shop.example", "one-click", now));

  // The tab saves its older settings (with its own new unsubscribe).
  const tabSettings = noteUnsubscribed(loaded.settings!, "promo@other.example", "mailto", new Date("2026-11-17T09:05:00Z"));
  const saved = await writeSnapshot(db, storageFor, tenant, { ...loaded, settings: tabSettings, knownIds: loaded.messages.map((m) => m.id) });
  assert.ok(saved.settings?.autoReply.sent.some((key) => key.startsWith("bob@example.com|")), "the auto-reply is still recorded");
  assert.deepEqual(saved.settings?.unsubscribed.map((u) => u.key).sort(), ["news@shop.example", "promo@other.example"]);

  // The merge itself: union, newest entry per key, never more than 200.
  const merged = keepServerNotes(
    { ...tabSettings, unsubscribed: [{ key: "a", at: "2026-01-01T00:00:00Z", method: "one-click" }] },
    { ...tabSettings, unsubscribed: [{ key: "a", at: "2026-02-01T00:00:00Z", method: "mailto" }] },
  );
  assert.deepEqual(merged.unsubscribed, [{ key: "a", at: "2026-02-01T00:00:00Z", method: "mailto" }]);
});

test("a stale tab's save cannot undo a server-side change: released sends and delivery reports keep the server's version", async () => {
  const { db, storageFor } = harness;
  const { releaseScheduledMail } = await import("./release.ts");
  const { writeDelivery } = await import("./records.ts");
  const tenant = "save-server-wins";
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  const scheduleAt = "2099-01-01T09:00:00.000Z";
  await writeSnapshot(db, storageFor, tenant, {
    ...(await readSnapshot(db, tenant)),
    messages: [
      letter({ id: "plan", folder: "drafts", subject: "Scheduled", extra: { scheduleAt } }),
      letter({ id: "sent-1", folder: "sent", subject: "Out" }),
      letter({ id: "note", folder: "inbox" }),
    ],
  });

  // The tab loads...
  const loaded = await readSnapshot(db, tenant);
  const knownIds = loaded.messages.map((m) => m.id);
  const knownRevs = loaded.revs ?? {};

  // ...then the server releases the scheduled send and records a delivery report for the other one.
  await releaseScheduledMail(db, storageFor, Date.parse(scheduleAt) + 60_000);
  await writeDelivery(db, tenant, "sent-1", [{ email: "x@example.com", status: "outbound", detail: "Bounced: 550 no such user" }]);
  const server = await readSnapshot(db, tenant);
  assert.equal(server.messages.find((m) => m.id === "plan")?.folder, "sent");
  assert.ok((server.revs?.plan ?? 0) > (knownRevs.plan ?? 0), "the release bumped the rev");

  // The stale tab stars an unrelated message and saves its old copies of the other two.
  const stale = loaded.messages.map((m) => (m.id === "note" ? { ...m, starred: true } : m));
  const saved = await writeSnapshot(db, storageFor, tenant, { ...loaded, messages: stale, knownIds, knownRevs });
  const byId = new Map(saved.messages.map((m) => [m.id, m]));
  assert.equal(byId.get("plan")?.folder, "sent", "the released send stays sent");
  assert.equal(byId.get("sent-1")?.delivery?.[0]?.detail, "Bounced: 550 no such user", "the delivery report stays");
  assert.equal(byId.get("note")?.starred, true, "the tab's own change is saved");
  assert.equal(saved.revs?.plan, server.revs?.plan, "revs survive the save");

  // Leaving out a message the server changed meanwhile does not delete it either.
  const dropped = await writeSnapshot(db, storageFor, tenant, {
    ...loaded,
    messages: stale.filter((m) => m.id !== "sent-1"),
    knownIds,
    knownRevs,
  });
  assert.ok(dropped.messages.some((m) => m.id === "sent-1"));

  // With the current revs (the tab reloaded), the person's edits to those messages apply again.
  const fresh = await readSnapshot(db, tenant);
  const edited = await writeSnapshot(db, storageFor, tenant, {
    ...fresh,
    messages: fresh.messages.map((m) => (m.id === "plan" ? { ...m, starred: true } : m)),
    knownIds: fresh.messages.map((m) => m.id),
    knownRevs: fresh.revs ?? {},
  });
  assert.equal(edited.messages.find((m) => m.id === "plan")?.starred, true);
  assert.equal(edited.messages.find((m) => m.id === "plan")?.folder, "sent");
});

test("an older client without knownRevs still overwrites (unchanged behaviour); knownRevs must be a map of counts", async () => {
  const { db, storageFor } = harness;
  const { writeDelivery } = await import("./records.ts");
  const { isRevMap } = await import("./mailbox.ts");
  const tenant = "save-legacy-revs";
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, "Ada"));
  await writeSnapshot(db, storageFor, tenant, { ...(await readSnapshot(db, tenant)), messages: [letter({ id: "out", folder: "sent" })] });
  const loaded = await readSnapshot(db, tenant);
  await writeDelivery(db, tenant, "out", [{ email: "x@example.com", status: "outbound", detail: "Bounced: 550" }]);
  const saved = await writeSnapshot(db, storageFor, tenant, { ...loaded, knownIds: loaded.messages.map((m) => m.id) });
  assert.deepEqual(saved.messages[0]?.delivery, loaded.messages[0]?.delivery, "the stale copy is written, as before");
  assert.notEqual(saved.messages[0]?.delivery?.[0]?.detail, "Bounced: 550");

  assert.equal(isRevMap({ a: 1, b: 0 }), true);
  for (const bad of [null, [], { a: -1 }, { a: 1.5 }, { a: "2" }]) assert.equal(isRevMap(bad), false, JSON.stringify(bad));
});
