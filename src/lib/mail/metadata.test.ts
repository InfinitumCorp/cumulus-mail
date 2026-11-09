import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addressBlind, findTenantByAddress } from "./directory.ts";
import { openText } from "./field-crypto.ts";
import { messageSnippet } from "./logic.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import { findMessageIds, readSnapshot } from "./records.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("subjects, addresses, snippets and headers are ciphertext with blind indexes", async () => {
  const { db, storageFor } = harness;
  const ada = profile("meta-ada", "ada.meta@cumuluscloud.app", "Ada Meta");
  const bea = profile("meta-bea", "bea.meta@cumuluscloud.app", "Bea Meta");
  await openMailbox(db, "meta-ada", ada);
  await openMailbox(db, "meta-bea", bea);
  const body = "The forecast holds for Thursday.";
  const snapshot: MailboxSnapshot = {
    me: ada,
    messages: [
      {
        id: "m-meta-1",
        threadId: "m-meta-1",
        folder: "inbox",
        from: { name: "Mira Chen", email: "mira.chen@cumuluscloud.app" },
        to: [{ name: "Ada Meta", email: ada.email }],
        cc: [],
        subject: "Quarterly review",
        body,
        at: "2026-11-07T12:00:00.000Z",
        unread: true,
        starred: false,
        labels: [],
        headers: { from: "Mira Chen <mira.chen@cumuluscloud.app>", subject: "Quarterly review" },
        auth: { spf: "pass", dkim: "pass", dmarc: "pass", policy: "reject", disposition: "deliver" },
      },
    ],
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "Ada Meta\nada.meta@cumuluscloud.app",
    rules: [],
  };
  await writeSnapshot(db, storageFor, "meta-ada", snapshot);

  const rows = await db.query<{
    subject: string;
    from_email: string;
    to_json: string;
    body: string;
    snippet_enc: string;
    headers_enc: string;
  }>(
    `select subject, from_email, to_json, body, snippet_enc, headers_enc
     from cumulus_mail.messages where tenant_id = $1 and id = $2`,
    ["meta-ada", "m-meta-1"],
  );
  const row = rows[0];
  assert.ok(row);
  for (const value of [row.subject, row.from_email, row.to_json, row.body, row.snippet_enc, row.headers_enc]) {
    assert.equal(value.includes("Quarterly"), false);
    assert.equal(value.includes("mira.chen"), false);
    assert.equal(value.includes("forecast"), false);
  }
  assert.equal(openText("meta-ada", row.subject), "Quarterly review");
  assert.equal(openText("meta-ada", row.snippet_enc), messageSnippet(body).slice(0, 180));
  assert.equal(JSON.parse(openText("meta-ada", row.headers_enc)).subject, "Quarterly review");
  assert.throws(() => openText("meta-bea", row.subject));

  const box = await db.query<{ address: string; display_name: string; signature: string; address_bidx: string }>(
    `select address, display_name, signature, address_bidx from cumulus_mail.mailboxes where tenant_id = $1`,
    ["meta-ada"],
  );
  assert.equal(box[0]?.address.includes("ada.meta"), false);
  assert.equal(box[0]?.display_name.includes("Ada"), false);
  assert.equal(box[0]?.signature.includes("ada.meta"), false);
  assert.equal(openText("meta-ada", box[0]?.display_name ?? ""), "Ada Meta");
  assert.equal(openText("meta-ada", box[0]?.signature ?? ""), "Ada Meta\nada.meta@cumuluscloud.app");
  assert.throws(() => openText("meta-bea", box[0]?.display_name ?? ""));
  assert.equal(box[0]?.address_bidx, addressBlind("meta-ada", ada.email));
  assert.notEqual(box[0]?.address_bidx, addressBlind("meta-bea", ada.email));
  const routes = await db.query<{ domain: string; address_bidx: string }>(
    `select domain, address_bidx from cumulus_mail.address_routes where tenant_id = $1 and address_bidx = $2`,
    ["meta-ada", box[0]?.address_bidx],
  );
  assert.equal(routes[0]?.domain, "cumuluscloud.app");
  assert.equal(routes[0]?.address_bidx.includes("ada.meta"), false);
  assert.equal(await findTenantByAddress(db, "ada.meta@cumuluscloud.app"), "meta-ada");
  const auth = await db.query<{ auth_json: string }>(
    `select auth_json from cumulus_mail.messages where tenant_id = $1 and id = $2`,
    ["meta-ada", "m-meta-1"],
  );
  assert.equal(auth[0]?.auth_json.includes("pass"), false);
  assert.equal(JSON.parse(openText("meta-ada", auth[0]?.auth_json ?? "")).dmarc, "pass");
  assert.throws(() => openText("meta-bea", auth[0]?.auth_json ?? ""));

  assert.deepEqual(await findMessageIds(db, "meta-ada", "subject", "Quarterly review"), ["m-meta-1"]);
  assert.deepEqual(await findMessageIds(db, "meta-ada", "from", "mira.chen@cumuluscloud.app"), ["m-meta-1"]);
  assert.deepEqual(await findMessageIds(db, "meta-ada", "to", ada.email), ["m-meta-1"]);
  assert.deepEqual(await findMessageIds(db, "meta-bea", "subject", "Quarterly review"), []);

  const opened = await readSnapshot(db, "meta-ada");
  assert.equal(opened.me.name, "Ada Meta");
  assert.equal(opened.signature, "Ada Meta\nada.meta@cumuluscloud.app");
  assert.equal(opened.messages[0]?.subject, "Quarterly review");
  assert.equal(opened.messages[0]?.headers?.subject, "Quarterly review");
  assert.equal(opened.messages[0]?.auth?.dmarc, "pass");

  const flipped = `${row.subject.slice(0, -1)}${row.subject.endsWith("A") ? "B" : "A"}`;
  await db.query(`update cumulus_mail.messages set subject = $2 where tenant_id = $1 and id = $3`, [
    "meta-ada",
    flipped,
    "m-meta-1",
  ]);
  await assert.rejects(() => readSnapshot(db, "meta-ada"));
});
