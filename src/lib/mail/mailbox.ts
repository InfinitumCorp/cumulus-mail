import { sanitizeContentType } from "../storage/adapter.ts";
import { assertTenantId, TenantAccessError } from "../storage/adapter.ts";
import type { TenantBlobs } from "../storage/index.ts";
import { base64ToBytes, newId } from "./bytes.ts";
import type { TenantStorage } from "./delivery.ts";
import { deliverPending } from "./delivery.ts";
import { addressOwnedByOther } from "./directory.ts";
import { validEmail } from "./logic.ts";
import type { Attachment, MailMessage } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { releaseDue } from "./schedule.ts";
import { reconcileFolders } from "./folders.ts";
import { sanitizeSettings } from "./settings.ts";
import {
  loadAttachmentMap,
  previousRawKeys,
  readSnapshot,
  replaceMailboxContents,
  type StoredAttachment,
} from "./records.ts";
import { fileName, type MailboxSnapshot } from "./snapshot.ts";
import { assertId } from "./snapshot.ts";
import { provisionMailbox } from "./seed.ts";
import type { MailProfile } from "./snapshot.ts";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 8;
const MAX_MESSAGES = 5000;
const MAX_BODY = 1_000_000;

export async function openMailbox(db: MailQuery, tenantId: string, profile: MailProfile): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  await provisionMailbox(db, tenantId, profile);
  return readSnapshot(db, tenantId);
}

function withoutBytes(file: Attachment): Attachment {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    contentType: file.contentType,
    sha256: file.sha256,
  };
}

export async function writeSnapshot(
  db: MailQuery,
  storageFor: TenantStorage,
  tenantId: string,
  snapshot: MailboxSnapshot,
): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  const current = await readSnapshot(db, tenantId);
  if (snapshot.messages.length > MAX_MESSAGES) throw new Error("Mailbox is too large");
  const existing = await loadAttachmentMap(db, tenantId);
  const byId = new Map<string, { messageId: string; file: StoredAttachment }>();
  for (const [messageId, files] of existing) {
    for (const file of files) {
      if (file.id) byId.set(file.id, { messageId, file });
    }
  }
  const rawKeys = await previousRawKeys(db, tenantId);
  const keptRaw = new Map<string, string | null>();
  const storedFiles: Array<{ messageId: string; file: StoredAttachment }> = [];
  const storage = storageFor(tenantId);
  const messages: MailMessage[] = [];

  // Mail in a folder the saved settings no longer list goes back to the Inbox.
  const folders = sanitizeSettings(snapshot.settings).folders;
  for (const incoming of reconcileFolders(releaseDue(snapshot.messages), folders)) {
    assertId(incoming.id, "message id");
    assertId(incoming.threadId, "thread id");
    const message: MailMessage =
      incoming.folder === "sent"
        ? { ...incoming, from: { name: current.me.name, email: current.me.email } }
        : incoming;
    const attachments = message.attachments ?? [];
    if (attachments.length > MAX_FILES) throw new Error("Too many attachments");
    const clean: Attachment[] = [];
    for (const file of attachments) {
      const name = fileName(file.name);
      if (file.dataBase64) {
        const bytes = base64ToBytes(file.dataBase64);
        if (bytes.byteLength > MAX_ATTACHMENT) throw new Error("Attachment is too large");
        const id = file.id && byId.get(file.id)?.messageId === message.id ? file.id : file.id && !byId.has(file.id) ? assertId(file.id, "attachment id") : newId("att");
        const contentType = sanitizeContentType(file.contentType);
        const saved = await storage.put(bytes);
        const stored: StoredAttachment = {
          id,
          name,
          size: bytes.byteLength,
          contentType,
          sha256: saved.sha256,
          objectKey: saved.blobId,
        };
        storedFiles.push({ messageId: message.id, file: stored });
        clean.push(withoutBytes(stored));
        continue;
      }
      const previous = file.id ? byId.get(file.id) : undefined;
      if (previous?.file.objectKey) {
        const id = previous.messageId === message.id ? previous.file.id! : newId("att");
        const stored: StoredAttachment = { ...previous.file, id, name };
        storedFiles.push({ messageId: message.id, file: stored });
        clean.push(withoutBytes(stored));
        continue;
      }
      clean.push({ name, size: Math.max(0, Math.trunc(file.size)) });
    }
    messages.push({
      ...message,
      subject: message.subject.slice(0, 500),
      body: message.body.slice(0, MAX_BODY),
      attachments: clean.length ? clean : undefined,
    });
    keptRaw.set(message.id, rawKeys.get(message.id) ?? null);
  }

  const aliases: string[] = [];
  for (const alias of snapshot.aliases) {
    const email = alias.trim().toLowerCase();
    if (!validEmail(email) || email === current.me.email.toLowerCase() || aliases.includes(email)) continue;
    if (await addressOwnedByOther(db, email, tenantId)) {
      throw new TenantAccessError("That address belongs to another mailbox");
    }
    aliases.push(email);
  }

  const next: MailboxSnapshot = {
    ...snapshot,
    me: current.me,
    messages,
    aliases,
    signature: snapshot.signature.slice(0, 4000),
    rules: snapshot.rules.filter((rule) => rule.action === "star" || rule.action === "archive" || rule.action === "label"),
  };
  const before = await blobIds(db, tenantId);
  await replaceMailboxContents(db, tenantId, next, storedFiles, keptRaw);
  await deliverPending(db, storageFor, tenantId);
  await discardUnreferenced(db, storage, tenantId, before);
  return readSnapshot(db, tenantId);
}

async function blobIds(db: MailQuery, tenantId: string): Promise<Set<string>> {
  const attachments = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1`,
    [tenantId],
  );
  const raws = await db.query<{ raw_key: string }>(
    `select raw_key from cumulus_mail.messages where tenant_id = $1 and raw_key is not null`,
    [tenantId],
  );
  return new Set([...attachments.map((row) => row.object_key), ...raws.map((row) => row.raw_key)]);
}

async function discardUnreferenced(
  db: MailQuery,
  storage: TenantBlobs,
  tenantId: string,
  before: Set<string>,
): Promise<void> {
  const keep = await blobIds(db, tenantId);
  for (const blobId of before) {
    if (!keep.has(blobId)) await storage.delete(blobId);
  }
}

export async function readAttachment(
  db: MailQuery,
  storage: TenantBlobs,
  tenantId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
  assertTenantId(tenantId);
  assertId(messageId, "message id");
  assertId(attachmentId, "attachment id");
  const rows = await db.query<{ name: string; content_type: string; object_key: string; sha256: string }>(
    `select name, content_type, object_key, sha256
     from cumulus_mail.attachments
     where tenant_id = $1 and message_id = $2 and id = $3`,
    [tenantId, messageId, attachmentId],
  );
  const row = rows[0];
  if (!row?.object_key) return null;
  const stored = await storage.get(row.object_key);
  if (!stored) return null;
  if (stored.sha256 !== row.sha256) {
    throw new Error("Stored attachment checksum does not match its record");
  }
  return { name: row.name, contentType: row.content_type, bytes: stored.body };
}
