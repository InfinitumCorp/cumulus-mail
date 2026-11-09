import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { syntheticGeoDatasets } from "../geo/sample.ts";
import { deliverMessage } from "./delivery.ts";
import { bytesToBase64 } from "./bytes.ts";
import { openText } from "./field-crypto.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { createSuppressionList } from "./suppression.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import type { MailMessage } from "./model.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[]): MailboxSnapshot {
  return {
    me,
    messages,
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "",
    rules: [],
  };
}

test("internal delivery copies the message and attachment, and external mail is not sent", async () => {
  const { db, storageFor } = harness;
  const ada = profile("del-ada", "ada.del@cumuluscloud.app", "Ada");
  const bea = profile("del-bea", "bea.del@cumuluscloud.app", "Bea");
  await openMailbox(db, "del-ada", ada);
  await openMailbox(db, "del-bea", bea);
  await writeSnapshot(db, storageFor, "del-bea", {
    ...snapshot(bea, []),
    aliases: ["bea.alias@cumuluscloud.app"],
    rules: [{ id: "rule-1", from: "ada.del", action: "star" }],
  });
  const payload = new TextEncoder().encode("attachment-bytes");
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    return Promise.reject(new Error("network disabled"));
  }) as typeof fetch;
  try {
    const sent = await writeSnapshot(
      db,
      storageFor,
      "del-ada",
      snapshot(ada, [
        {
          id: "m-out-1",
          threadId: "m-out-1",
          folder: "sent",
          from: { name: "Imposter", email: "imposter@example.test" },
          to: [{ name: "Bea", email: "bea.alias@cumuluscloud.app" }],
          cc: [{ name: "Priya", email: "priya@vyral.example" }],
          subject: "Inside",
          body: "hand to Bea",
          at: "2026-11-07T15:00:00.000Z",
          unread: false,
          starred: false,
          labels: [],
          attachments: [
            {
              name: "a.txt",
              size: payload.byteLength,
              contentType: "text/plain",
              dataBase64: bytesToBase64(payload),
            },
          ],
        },
      ]),
    );
    const hopToBea = sent.messages
      .find((message) => message.id === "m-out-1")
      ?.delivery?.find((hop) => hop.email === "bea.alias@cumuluscloud.app");
    const hopOut = sent.messages
      .find((message) => message.id === "m-out-1")
      ?.delivery?.find((hop) => hop.email === "priya@vyral.example");
    assert.equal(hopToBea?.status, "inside");
    assert.equal(hopOut?.status, "outbound");
    assert.match(hopOut?.detail ?? "", /does not send outside Cumulus/);
    assert.equal(hopOut?.detail?.includes("Geo site"), false);
    assert.equal(sent.messages.find((message) => message.id === "m-out-1")?.from.email, ada.email);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }

  const beaBox = await readSnapshot(db, "del-bea");
  const copy = beaBox.messages.find((message) => message.subject === "Inside");
  assert.ok(copy);
  assert.equal(copy.starred, true);
  assert.equal(copy.from.email, ada.email);
  assert.equal(copy.body, "hand to Bea");
  const file = copy.attachments?.[0];
  assert.ok(file?.id);
  const stored = await readAttachment(db, storageFor("del-bea"), "del-bea", copy.id, file.id);
  assert.equal(new TextDecoder().decode(stored?.bytes), "attachment-bytes");
  const adaAgain = await readSnapshot(db, "del-ada");
  assert.equal(
    adaAgain.messages.some((message) => message.id === copy.id),
    false,
  );
});

test("a suppressed recipient is not delivered", async () => {
  const { db, storageFor } = harness;
  const ada = profile("sup-ada", "sup.ada@cumuluscloud.app", "Ada");
  const bea = profile("sup-bea", "sup.bea@cumuluscloud.app", "Bea");
  await openMailbox(db, "sup-ada", ada);
  await openMailbox(db, "sup-bea", bea);
  await createSuppressionList(db, "sup-ada").add("sup.bea@cumuluscloud.app", "abuse");
  const sent = await writeSnapshot(
    db,
    storageFor,
    "sup-ada",
    snapshot(ada, [
      {
        id: "m-sup-1",
        threadId: "m-sup-1",
        folder: "sent",
        from: { name: "Ada", email: ada.email },
        to: [{ name: "Bea", email: "sup.bea@cumuluscloud.app" }],
        cc: [],
        subject: "Nope",
        body: "blocked",
        at: "2026-11-07T16:00:00.000Z",
        unread: false,
        starred: false,
        labels: [],
      },
    ]),
  );
  assert.equal(
    sent.messages.find((message) => message.id === "m-sup-1")?.delivery?.[0]?.detail,
    "Suppressed. Not delivered.",
  );
  const beaBox = await readSnapshot(db, "sup-bea");
  assert.equal(
    beaBox.messages.some((message) => message.subject === "Nope"),
    false,
  );
  const bounces = await db.query<{ recipient: string }>(
    `select recipient from cumulus_mail.bounces where tenant_id = $1`,
    ["sup-ada"],
  );
  assert.equal(
    bounces.some((row) => openText("sup-ada", row.recipient) === "sup.bea@cumuluscloud.app"),
    true,
  );
  assert.equal(
    bounces.some((row) => row.recipient.includes("sup.bea@cumuluscloud.app")),
    false,
  );
});

test("delivery annotation is appended only when geo is enabled", async () => {
  const { db, storageFor } = harness;
  const ada = profile("geo-ada", "geo.ada@cumuluscloud.app", "Ada");
  await openMailbox(db, "geo-ada", ada);
  const message = {
    id: "m-geo-out",
    threadId: "m-geo-out",
    folder: "sent" as const,
    from: { name: "Ada", email: ada.email },
    to: [{ name: "Ads", email: "news@ads.example" }],
    cc: [],
    subject: "Outside",
    body: "held",
    at: "2026-11-07T17:00:00.000Z",
    unread: false,
    starred: false,
    labels: [],
  };
  const plain = await deliverMessage(db, storageFor, "geo-ada", message);
  assert.equal(plain[0]?.detail.includes("Geo site"), false);
  const noted = await deliverMessage(db, storageFor, "geo-ada", message, {
    env: { INFINITUM_GEO_ENABLED: "1" },
    datasets: syntheticGeoDatasets(),
    log: () => {},
  });
  assert.equal(noted[0]?.status, "outbound");
  assert.match(noted[0]?.detail ?? "", /does not send outside Cumulus/);
  assert.match(noted[0]?.detail ?? "", /Geo site: category-ads/);
});
