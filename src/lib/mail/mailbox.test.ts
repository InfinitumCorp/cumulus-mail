import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TenantAccessError } from "../storage/adapter.ts";
import { findTenantByAddress } from "./directory.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { rejectCallerTenant } from "./snapshot.ts";
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
