import { checksumOf, sha256Hex, type StorageAdapter } from "../storage/adapter.ts";
import { newId } from "./bytes.ts";
import { findTenantByAddress } from "./directory.ts";
import { applyRules, isCumulus } from "./logic.ts";
import type { DeliveryHop, MailMessage, MailRule, Person } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { insertAttachment, insertMessage, loadAttachmentMap, type StoredAttachment } from "./records.ts";
import { createSuppressionList } from "./suppression.ts";

export type TenantStorage = (tenantId: string) => StorageAdapter;

const HELD = "Held in the outbox. This preview does not send outside Cumulus.";

async function copyId(senderTenant: string, messageId: string, destTenant: string): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(`${senderTenant}\n${messageId}\n${destTenant}`));
  return `d-${hex.slice(0, 32)}`;
}

async function rulesFor(db: MailQuery, tenantId: string): Promise<MailRule[]> {
  const rows = await db.query<{ id: string; from_match: string; action: string; label: string | null }>(
    `select id, from_match, action, label from cumulus_mail.rules where tenant_id = $1`,
    [tenantId],
  );
  return rows
    .filter((row) => row.action === "star" || row.action === "archive" || row.action === "label")
    .map((row) => ({
      id: row.id,
      from: row.from_match,
      action: row.action as MailRule["action"],
      label: row.label ?? undefined,
    }));
}

async function alreadyStored(db: MailQuery, tenantId: string, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `select id from cumulus_mail.messages where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, id],
  );
  return rows.length > 0;
}

async function copyInto(
  db: MailQuery,
  storageFor: TenantStorage,
  senderTenant: string,
  destTenant: string,
  message: MailMessage,
  files: StoredAttachment[],
): Promise<void> {
  const id = await copyId(senderTenant, message.id, destTenant);
  if (await alreadyStored(db, destTenant, id)) return;
  const rules = await rulesFor(db, destTenant);
  const delivered = applyRules(
    {
      ...message,
      id,
      folder: "inbox",
      unread: true,
      starred: false,
      delivery: [{ email: message.from.email, status: "inside", detail: "Delivered inside Cumulus." }],
    },
    rules,
  );
  await insertMessage(db, destTenant, delivered, null);
  for (const [index, file] of files.entries()) {
    const stored = await storageFor(senderTenant).get(file.objectKey);
    if (!stored) continue;
    const attachmentId = `a-${id}-${index}`;
    const objectKey = `messages/${id}/attachments/${attachmentId}`;
    await storageFor(destTenant).put(objectKey, stored.body, {
      contentType: stored.contentType,
      checksumSha256: stored.checksumSha256,
    });
    await insertAttachment(db, destTenant, id, {
      id: attachmentId,
      name: file.name,
      size: stored.body.byteLength,
      contentType: stored.contentType,
      sha256: stored.checksumSha256,
      objectKey,
    });
  }
}

function uniquePeople(people: Person[]): Person[] {
  const seen = new Set<string>();
  const result: Person[] = [];
  for (const person of people) {
    const email = person.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push({ ...person, email });
  }
  return result;
}

export async function deliverMessage(
  db: MailQuery,
  storageFor: TenantStorage,
  senderTenant: string,
  message: MailMessage,
): Promise<DeliveryHop[]> {
  const suppressions = createSuppressionList(db, senderTenant);
  const files = (await loadAttachmentMap(db, senderTenant)).get(message.id) ?? [];
  const hops: DeliveryHop[] = [];
  for (const person of uniquePeople([...message.to, ...message.cc])) {
    if (await suppressions.has(person.email)) {
      const id = newId("bounce");
      await db.query(
        `insert into cumulus_mail.bounces (
           tenant_id, id, message_id, recipient, action, status, diagnostic
         ) values ($1,$2,$3,$4,'failed','5.7.1',$5)`,
        [senderTenant, id, message.id, person.email, "Recipient is on the suppression list"],
      );
      hops.push({ email: person.email, status: "outbound", detail: "Suppressed. Not delivered." });
      continue;
    }
    if (!isCumulus(person.email)) {
      hops.push({ email: person.email, status: "outbound", detail: HELD });
      continue;
    }
    const dest = await findTenantByAddress(db, person.email);
    if (!dest) {
      hops.push({ email: person.email, status: "inside", detail: "No Cumulus mailbox for this address. Not delivered." });
      continue;
    }
    await copyInto(db, storageFor, senderTenant, dest, message, files);
    hops.push({ email: person.email, status: "inside", detail: "Delivered inside Cumulus." });
  }
  return hops;
}

export async function deliverPending(db: MailQuery, storageFor: TenantStorage, senderTenant: string): Promise<void> {
  const pending = await db.query<{ id: string }>(
    `select id from cumulus_mail.messages m
     where m.tenant_id = $1 and m.folder = 'sent' and not exists (
       select 1 from cumulus_mail.deliveries d
       where d.sender_tenant = m.tenant_id and d.message_id = m.id
     )`,
    [senderTenant],
  );
  if (pending.length === 0) return;
  const snapshotMessages = await db.query<{
    id: string;
    thread_id: string;
    folder: string;
    from_name: string;
    from_email: string;
    to_json: string;
    cc_json: string;
    subject: string;
    body: string;
    sent_at: string;
    unread: boolean;
    starred: boolean;
    labels_json: string;
    snooze_until: string | null;
    delivery_json: string | null;
    raw_key: string | null;
  }>(
    `select id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body, sent_at,
            unread, starred, labels_json, snooze_until, delivery_json, raw_key
     from cumulus_mail.messages where tenant_id = $1 and folder = 'sent'`,
    [senderTenant],
  );
  const byId = new Map(snapshotMessages.map((row) => [row.id, row]));
  for (const item of pending) {
    const row = byId.get(item.id);
    if (!row) continue;
    const message: MailMessage = {
      id: row.id,
      threadId: row.thread_id,
      folder: "sent",
      from: { name: row.from_name, email: row.from_email },
      to: JSON.parse(row.to_json) as Person[],
      cc: JSON.parse(row.cc_json) as Person[],
      subject: row.subject,
      body: row.body,
      at: row.sent_at,
      unread: false,
      starred: row.starred === true,
      labels: JSON.parse(row.labels_json) as string[],
    };
    const hops = await deliverMessage(db, storageFor, senderTenant, message);
    await db.query(
      `update cumulus_mail.messages set delivery_json = $3 where tenant_id = $1 and id = $2`,
      [senderTenant, message.id, JSON.stringify(hops)],
    );
    await db.query(
      `insert into cumulus_mail.deliveries (sender_tenant, message_id) values ($1, $2) on conflict do nothing`,
      [senderTenant, message.id],
    );
  }
}

export async function putBytes(
  storage: StorageAdapter,
  objectKey: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ sha256: string }> {
  const checksumSha256 = await checksumOf(body);
  await storage.put(objectKey, body, { contentType, checksumSha256 });
  return { sha256: checksumSha256 };
}
