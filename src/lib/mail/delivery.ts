import { sha256Hex, type TenantBlobs } from "../storage/index.ts";
import { newId } from "./bytes.ts";
import { findTenantByAddress } from "./directory.ts";
import { sealText } from "./field-crypto.ts";
import { applyRules, isCumulus } from "./logic.ts";
import type { DeliveryHop, MailMessage, MailRule, Person } from "./model.ts";
import { issueProtectedLink } from "./protect-store.ts";
import type { MailQuery } from "./query.ts";
import { insertAttachment, insertMessage, loadAttachmentMap, readMessages, readProfile, readSettings, writeDelivery, writeSettings, type StoredAttachment } from "./records.ts";
import { isHeld } from "./schedule.ts";
import { applySieve } from "./sieve.ts";
import { noteAutoReply, shouldAutoReply } from "./settings.ts";
import { createSuppressionList } from "./suppression.ts";

export type TenantStorage = (tenantId: string) => TenantBlobs;

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
  const settings = await readSettings(db, destTenant);
  const delivered = applySieve(
    applyRules(
      {
        ...message,
        id,
        folder: "inbox",
        unread: true,
        starred: false,
        delivery: [{ email: message.from.email, status: "inside", detail: "Delivered inside Cumulus." }],
      },
      rules,
    ),
    settings.sieve,
    settings.folders,
  );
  await insertMessage(db, destTenant, delivered, null);
  for (const [index, file] of files.entries()) {
    const stored = await storageFor(senderTenant).get(file.objectKey);
    if (!stored) continue;
    const attachmentId = `a-${id}-${index}`;
    const saved = await storageFor(destTenant).put(stored.body);
    await insertAttachment(db, destTenant, id, {
      id: attachmentId,
      name: file.name,
      size: stored.body.byteLength,
      contentType: file.contentType ?? "application/octet-stream",
      sha256: saved.sha256,
      objectKey: saved.blobId,
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
        [senderTenant, id, message.id, sealText(senderTenant, person.email), "Recipient is on the suppression list"],
      );
      hops.push({ email: person.email, status: "outbound", detail: "Suppressed. Not delivered." });
      continue;
    }
    if (!isCumulus(person.email)) {
      if (message.extra?.protection) {
        const link = await issueProtectedLink(db, senderTenant, message.extra.protection);
        hops.push({
          email: person.email,
          status: "outbound",
          detail: `Password-protected. ${link.href} External SMTP is not configured.`,
        });
      } else {
        hops.push({ email: person.email, status: "outbound", detail: HELD });
      }
      continue;
    }
    const dest = await findTenantByAddress(db, person.email);
    if (!dest) {
      hops.push({ email: person.email, status: "inside", detail: "No Cumulus mailbox for this address. Not delivered." });
      continue;
    }
    await copyInto(db, storageFor, senderTenant, dest, message, files);
    hops.push({ email: person.email, status: "inside", detail: "Delivered inside Cumulus." });
    if (!message.extra?.autoReply && dest !== senderTenant) {
      const settings = await readSettings(db, dest);
      if (shouldAutoReply(settings, message.from.email)) {
        const profile = await readProfile(db, dest);
        if (profile) {
          await insertMessage(
            db,
            senderTenant,
            {
              id: newId("ar"),
              threadId: message.threadId,
              folder: "inbox",
              from: { name: profile.name, email: profile.email },
              to: [{ name: message.from.name, email: message.from.email }],
              cc: [],
              subject: settings.autoReply.subject || "Away",
              body: settings.autoReply.body,
              at: new Date().toISOString(),
              unread: true,
              starred: false,
              labels: ["Auto-reply"],
              extra: { autoReply: true },
            },
            null,
          );
          await writeSettings(db, dest, noteAutoReply(settings, message.from.email));
        }
      }
    }
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
  const snapshotMessages = await readMessages(db, senderTenant);
  const byId = new Map(snapshotMessages.filter((message) => message.folder === "sent").map((message) => [message.id, message]));
  for (const item of pending) {
    const message = byId.get(item.id);
    if (!message || isHeld(message)) continue;
    if (message.extra?.scheduleAt && Date.parse(message.extra.scheduleAt) > Date.now()) continue;
    const hops = await deliverMessage(db, storageFor, senderTenant, message);
    await writeDelivery(db, senderTenant, message.id, hops);
    await db.query(
      `insert into cumulus_mail.deliveries (sender_tenant, message_id) values ($1, $2) on conflict do nothing`,
      [senderTenant, message.id],
    );
  }
}

export async function putBytes(storage: TenantBlobs, body: Uint8Array): Promise<{ blobId: string; sha256: string }> {
  return storage.put(body);
}
