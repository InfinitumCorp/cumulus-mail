import { limitsFor, newMailboxPlan, planLabel } from "./plans.ts";
import { assertTenantId } from "../storage/adapter.ts";
import { mailboxAddress } from "./domain.ts";
import { addressBlind, publishAddress } from "./directory.ts";
import { sealText } from "./field-crypto.ts";
import { validEmail } from "./logic.ts";
import { SEED_CONTACTS, SEED_MESSAGES, SEED_TASKS } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { insertMessage } from "./records.ts";

function previewAddress(): string {
  return mailboxAddress("alex");
}

const DEMO_ACCOUNTS: Array<[string, string, string]> = [
  ["demo-mira", "Mira Chen", "mira.chen"],
  ["demo-jordan", "Jordan Hale", "jordan.hale"],
  ["demo-leah", "Leah Okonkwo", "leah"],
  ["demo-security", "CID Security", "security"],
  ["demo-scalvs", "SCALVS", "scalvs"],
  ["demo-ledger", "Firmament Network", "ledger"],
  ["demo-exchange", "Data Exchange", "exchange"],
  ["demo-veil", "VEIL", "veil"],
  ["demo-office", "FIRM Office", "office"],
];

export async function ensureDemoDirectory(db: MailQuery): Promise<void> {
  for (const [tenantId, name, localPart] of DEMO_ACCOUNTS) {
    const address = mailboxAddress(localPart);
    await db.query(
      `insert into cumulus_mail.mailboxes (
         tenant_id, address, address_bidx, display_name, cid, plan, quota_gb, signature, seeded
       ) values ($1,$2,$3,$4,$5,'Free',15,$6,true)
       on conflict (tenant_id) do nothing`,
      [
        tenantId,
        sealText(tenantId, address),
        addressBlind(tenantId, address),
        sealText(tenantId, name),
        `cid:${tenantId}`,
        sealText(tenantId, `${name}\n${address}`),
      ],
    );
    await publishAddress(db, tenantId, address);
  }
}

export async function seedPreviewContents(db: MailQuery, tenantId: string): Promise<void> {
  for (const message of SEED_MESSAGES) {
    await insertMessage(db, tenantId, message, null);
    if (message.folder === "sent") {
      await db.query(
        `insert into cumulus_mail.deliveries (sender_tenant, message_id) values ($1, $2) on conflict do nothing`,
        [tenantId, message.id],
      );
    }
  }
  for (const contact of SEED_CONTACTS) {
    await db.query(
      `insert into cumulus_mail.contacts (tenant_id, id, name, email, org, note) values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing`,
      [tenantId, contact.id, contact.name, contact.email, contact.org, contact.note],
    );
  }
  for (const task of SEED_TASKS) {
    await db.query(
      `insert into cumulus_mail.tasks (tenant_id, id, title, detail, done, message_id) values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing`,
      [tenantId, task.id, task.title, task.detail, task.done, task.messageId ?? null],
    );
  }
  await db.query(
    `insert into cumulus_mail.aliases (tenant_id, address, address_bidx) values ($1, $2, $3)
     on conflict (tenant_id, address_bidx) do nothing`,
    [tenantId, sealText(tenantId, "press@cumuluscloud.app"), addressBlind(tenantId, "press@cumuluscloud.app")],
  );
  await publishAddress(db, tenantId, "press@cumuluscloud.app");
  await db.query(`update cumulus_mail.mailboxes set signature = $2 where tenant_id = $1`, [
    tenantId,
    sealText(tenantId, "Alex Reid\nalex@cumuluscloud.app"),
  ]);
}

export async function provisionMailbox(
  db: MailQuery,
  tenantId: string,
  profile: { name: string; email: string; cid: string; plan: string; quotaGb: number },
): Promise<void> {
  assertTenantId(tenantId);
  const email = profile.email.trim().toLowerCase();
  if (!validEmail(email)) throw new Error("Mailbox address is invalid");
  const startPlan = newMailboxPlan();
  await db.query(
    `insert into cumulus_mail.mailboxes (
       tenant_id, address, address_bidx, display_name, cid, plan, quota_gb, signature, seeded, plan_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,false,$9)
     on conflict (tenant_id) do nothing`,
    [
      tenantId,
      sealText(tenantId, email),
      addressBlind(tenantId, email),
      sealText(tenantId, profile.name.slice(0, 200)),
      profile.cid.slice(0, 200),
      planLabel(startPlan),
      limitsFor(startPlan).quotaGb,
      sealText(tenantId, `${profile.name}\n${email}`),
      startPlan,
    ],
  );
  await publishAddress(db, tenantId, email);
  if (email === previewAddress()) await ensureDemoDirectory(db);
  const claimed = await db.query<{ tenant_id: string }>(
    `update cumulus_mail.mailboxes set seeded = true where tenant_id = $1 and seeded = false returning tenant_id`,
    [tenantId],
  );
  if (claimed.length === 0) return;
  if (email === previewAddress()) await seedPreviewContents(db, tenantId);
}
