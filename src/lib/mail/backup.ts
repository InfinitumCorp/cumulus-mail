import { checksumOf, ChecksumMismatchError, sanitizeContentType, assertTenantId } from "../storage/adapter.ts";
import type { TenantBlobs } from "../storage/index.ts";
import { bytesToBase64, base64ToBytes } from "./bytes.ts";
import type { TenantStorage } from "./delivery.ts";
import { deliverPending } from "./delivery.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import type { MailQuery } from "./query.ts";
import { loadAttachmentMap, previousRawKeys, readSnapshot, replaceMailboxContents } from "./records.ts";
import { createSuppressionList } from "./suppression.ts";

export type BackupBlob = {
  objectKey: string;
  sha256: string;
  contentType: string;
  dataBase64: string;
};

export type BackupAttachment = {
  messageId: string;
  id: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
  objectKey: string;
};

export type MailboxBackup = MailboxSnapshot & {
  version: 1;
  exportedAt: string;
  attachments: BackupAttachment[];
  blobs: BackupBlob[];
  rawKeys: Array<{ messageId: string; objectKey: string }>;
  suppressions: Array<{ address: string; reason: string }>;
  deliveredIds: string[];
  /** Ignored on import. A backup cannot choose the destination tenant. */
  tenantId?: string;
};

export async function exportMailbox(
  db: MailQuery,
  storage: TenantBlobs,
  tenantId: string,
): Promise<MailboxBackup> {
  assertTenantId(tenantId);
  const snapshot = await readSnapshot(db, tenantId);
  const map = await loadAttachmentMap(db, tenantId);
  const attachments: BackupAttachment[] = [];
  for (const [messageId, files] of map) {
    for (const file of files) {
      if (!file.id) continue;
      attachments.push({
        messageId,
        id: file.id,
        name: file.name,
        size: file.size,
        contentType: file.contentType ?? "application/octet-stream",
        sha256: file.sha256 ?? "",
        objectKey: file.objectKey,
      });
    }
  }
  const rawRows = await previousRawKeys(db, tenantId);
  const rawKeys = [...rawRows.entries()]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([messageId, objectKey]) => ({ messageId, objectKey }));
  const blobs: BackupBlob[] = [];
  const seen = new Set<string>();
  const described = new Map(attachments.map((file) => [file.objectKey, file.contentType]));
  for (const raw of rawKeys) described.set(raw.objectKey, "message/rfc822");
  for (const [objectKey, contentType] of described) {
    if (!objectKey || seen.has(objectKey)) continue;
    seen.add(objectKey);
    const stored = await storage.get(objectKey);
    if (!stored) continue;
    blobs.push({
      objectKey,
      sha256: stored.sha256,
      contentType,
      dataBase64: bytesToBase64(stored.body),
    });
  }
  const delivered = await db.query<{ message_id: string }>(
    `select message_id from cumulus_mail.deliveries where sender_tenant = $1`,
    [tenantId],
  );
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    ...snapshot,
    attachments,
    blobs,
    rawKeys,
    suppressions: await createSuppressionList(db, tenantId).list(),
    deliveredIds: delivered.map((row) => row.message_id),
  };
}

export async function importMailbox(
  db: MailQuery,
  storageFor: TenantStorage,
  tenantId: string,
  backup: MailboxBackup,
): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  if (backup.version !== 1) throw new Error("Unsupported mailbox backup");
  const storage = storageFor(tenantId);
  const idMap = new Map<string, string>();
  for (const blob of backup.blobs) {
    const bytes = base64ToBytes(blob.dataBase64);
    const checksumSha256 = await checksumOf(bytes);
    if (checksumSha256 !== blob.sha256.toLowerCase()) throw new ChecksumMismatchError(blob.objectKey);
    const saved = await storage.put(bytes);
    idMap.set(blob.objectKey, saved.blobId);
  }

  await db.query(`delete from cumulus_mail.suppressions where tenant_id = $1`, [tenantId]);
  const suppressions = createSuppressionList(db, tenantId);
  for (const entry of backup.suppressions ?? []) {
    await suppressions.add(entry.address, entry.reason);
  }
  for (const messageId of backup.deliveredIds ?? []) {
    await db.query(
      `insert into cumulus_mail.deliveries (sender_tenant, message_id) values ($1, $2) on conflict do nothing`,
      [tenantId, messageId],
    );
  }

  const rawKeys = new Map<string, string | null>();
  for (const entry of backup.rawKeys ?? []) rawKeys.set(entry.messageId, idMap.get(entry.objectKey) ?? null);
  const files = (backup.attachments ?? []).map((file) => ({
    messageId: file.messageId,
    file: {
      id: file.id,
      name: file.name,
      size: file.size,
      contentType: sanitizeContentType(file.contentType),
      sha256: file.sha256,
      objectKey: idMap.get(file.objectKey) ?? file.objectKey,
    },
  }));
  const current = await readSnapshot(db, tenantId);
  await replaceMailboxContents(
    db,
    tenantId,
    {
      me: current.me,
      messages: backup.messages,
      aliases: backup.aliases,
      briefs: backup.briefs,
      tasks: backup.tasks,
      contacts: backup.contacts,
      signature: backup.signature,
      rules: backup.rules,
    },
    files,
    rawKeys,
  );
  await deliverPending(db, storageFor, tenantId);
  return readSnapshot(db, tenantId);
}
