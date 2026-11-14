import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./test-support.ts";

const TABLES = [
  "mailboxes",
  "aliases",
  "messages",
  "outbound_queue",
  "attachments",
  "contacts",
  "tasks",
  "rules",
  "briefs",
  "suppressions",
  "abuse_reports",
  "bounces",
  "deliveries",
  "share_grants",
  "message_blind",
  "address_routes",
  "protected_links",
  "billing_events",
  "calendar_feeds",
  "message_words",
  "outbound_pauses",
  "bridge_tokens",
  "message_uids",
  "bridge_folders",
  "sender_reputation",
  "spam_lists",
];

test("row level security is enabled on every mail table and no policies are added", async () => {
  const harness = await createHarness();
  try {
    const tables = await harness.db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'cumulus_mail' and c.relkind = 'r'
       order by c.relname`,
    );
    assert.deepEqual(
      tables.map((row) => row.relname),
      [...TABLES].sort(),
    );
    for (const row of tables) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, false, row.relname);
    }
    const policies = await harness.db.query<{ polname: string }>(
      `select p.polname
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'cumulus_mail'`,
    );
    assert.deepEqual(policies, []);
    await harness.db.query(
      `insert into cumulus_mail.mailboxes (
         tenant_id, address, display_name, cid, plan, quota_gb
       ) values ('rls-probe', 'sealed', 'sealed', 'cid:rls-probe', 'Free', 15)`,
    );
    const inserted = await harness.db.query<{ tenant_id: string }>(
      `select tenant_id from cumulus_mail.mailboxes where tenant_id = 'rls-probe'`,
    );
    assert.equal(inserted[0]?.tenant_id, "rls-probe");
  } finally {
    await harness.close();
  }
});
