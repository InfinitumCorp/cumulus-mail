import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./test-support.ts";
import { handleCidEvent, tenantForCid, type CidEvent } from "./cid-events.ts";
import { readSnapshot } from "./records.ts";
import { writeSnapshot } from "./mailbox.ts";
import { readFileSync } from "node:fs";

test("a Cumulus://ID rename that lands while a save is running stays (the name is decided under the save's lock)", async () => {
  const h = await createHarness();
  for (const stmt of readFileSync(new URL("../../../migrations/auth/0001_auth.sql", import.meta.url), "utf8").split(/;\s*\n/)) if (stmt.trim()) await h.db.query(stmt);
  const cid = "cid_44444444-4444-4444-8444-444444444444";
  const at = new Date().toISOString();
  await handleCidEvent(h.db, { cid, type: "account.created", detail: { username: "maid", displayName: "Marian", mailAddress: "maid@cumuluscloud.app" }, at }, "cumuluscloud.app");
  const tenant = (await tenantForCid(h.db, cid))!;
  const tab = await readSnapshot(h.db, tenant);
  let fired = false;
  const storageFor = (t: string) => {
    const s = h.storageFor(t);
    // The rename arrives while the save is uploading an attachment, before it takes the row lock.
    return { ...s, put: async (b: Uint8Array) => {
      if (!fired) { fired = true; const e: CidEvent = { cid, type: "profile.updated", detail: { displayName: "Maid Marian", previous: "Marian" }, at: new Date(Date.parse(at) + 1000).toISOString() };
        assert.equal(await handleCidEvent(h.db, e, "cumuluscloud.app"), "renamed"); }
      return s.put(b);
    } } as never;
  };
  const msg = { id: "m1", threadId: "m1", folder: "drafts", from: tab.me, to: [], cc: [], subject: "x", body: "y", at, unread: false, starred: false, labels: [], attachments: [{ name: "a.txt", size: 2, contentType: "text/plain", dataBase64: "aGk=" }] };
  await writeSnapshot(h.db, storageFor, tenant, { ...tab, messages: [...tab.messages, msg as never] });
  const after = await readSnapshot(h.db, tenant);
  assert.ok(fired, "the rename ran in the middle of the save");
  assert.equal(after.me.name, "Maid Marian");
  await h.close();
});
