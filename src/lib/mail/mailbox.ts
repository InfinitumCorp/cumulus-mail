import { sanitizeContentType } from "../storage/adapter.ts";
import { assertTenantId, TenantAccessError } from "../storage/adapter.ts";
import type { TenantBlobs } from "../storage/index.ts";
import { base64ToBytes, newId } from "./bytes.ts";
import type { TenantStorage } from "./delivery.ts";
import { deliverPending } from "./delivery.ts";
import { addressOwnedByOther } from "./directory.ts";
import { requestedDomainCount, sanitizeSettings } from "./settings.ts";
import { DEFAULT_PLAN, limitsFor } from "./plans.ts";
import { mailDomain } from "./domain.ts";
import { validEmail } from "./logic.ts";
import type { Attachment, MailMessage } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { releaseDue } from "./schedule.ts";
import { reconcileFolders } from "./folders.ts";
import {
  loadAttachmentMap,
  previousRawKeys,
  readSnapshot,
  replaceMailboxContents,
  type StoredAttachment,
} from "./records.ts";
import { fileName, type MailboxSnapshot } from "./snapshot.ts";
import { applyDelta, type MailboxDelta } from "./delta.ts";
import { assertId } from "./snapshot.ts";
import { provisionMailbox } from "./seed.ts";
import type { MailProfile } from "./snapshot.ts";

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_FILES = 8;
export const MAX_BODY = 1_000_000;


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

/** A `knownRevs` map as the client sends it: message id -> a non-negative integer. */
export function isRevMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((rev) => Number.isSafeInteger(rev) && (rev as number) >= 0);
}

/**
 * The aliases a mailbox may keep: valid, not its own address, not another mailbox's (that would let it
 * receive or send as someone else), and within its plan. A mailbox that already holds more (saved before
 * this check existed) keeps them but cannot add more. Used by every path that writes aliases: a save
 * (writeSnapshot) and a backup import (backup.ts).
 */
/** Names on the platform domain nobody may take: mail to them is about the service, not a person. */
export const RESERVED_LOCAL_PARTS = new Set([
  "postmaster", "abuse", "hostmaster", "webmaster", "admin", "administrator", "root", "security", "support",
  "noreply", "no-reply", "mailer-daemon", "billing", "help", "info", "dmarc", "dmarc-reports", "privacy", "legal",
]);

/**
 * Where an alias may be: the platform mail domain (not a reserved name), or one of this mailbox's own
 * custom domains that the server has verified. The client sends the alias list, so without this an
 * alias could claim any unrouted address, including one on another customer's verified domain, and
 * receive that domain's mail. Aliases the mailbox already has stay valid.
 */
export function aliasAllowed(email: string, current: MailboxSnapshot): boolean {
  if (current.aliases.some((alias) => alias.toLowerCase() === email)) return true;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === mailDomain()) return !RESERVED_LOCAL_PARTS.has(local.split("+")[0]!);
  return (current.settings?.domains ?? []).some((item) => item.verified && item.domain.toLowerCase() === domain);
}

export async function checkedAliases(
  db: MailQuery,
  tenantId: string,
  current: MailboxSnapshot,
  requested: readonly unknown[],
  /** A save refuses another mailbox's address outright; an import skips it and restores the rest. */
  ownedByOther: "refuse" | "skip" = "refuse",
): Promise<string[]> {
  const limits = current.me.limits ?? limitsFor(DEFAULT_PLAN);
  const aliases: string[] = [];
  for (const alias of requested) {
    if (typeof alias !== "string") continue;
    const email = alias.trim().toLowerCase();
    if (!validEmail(email) || email === current.me.email.toLowerCase() || aliases.includes(email)) continue;
    if (!aliasAllowed(email, current)) {
      if (ownedByOther === "skip") continue;
      throw new TenantAccessError(`An address can be on ${mailDomain()} or on one of your verified domains.`);
    }
    if (await addressOwnedByOther(db, email, tenantId)) {
      if (ownedByOther === "skip") continue;
      throw new TenantAccessError("That address belongs to another mailbox");
    }
    aliases.push(email);
  }
  const allowed = Math.max(limits.aliases, current.aliases.length);
  // An import restores what the plan allows and leaves the rest out; a save says no.
  if (aliases.length > allowed && ownedByOther === "skip") return aliases.slice(0, allowed);
  if (aliases.length > allowed) {
    throw new Error(`You can have up to ${limits.aliases} addresses.`);
  }
  return aliases;
}

/** A small save (delta.ts): applied on top of what the server has, then written like a full save. */
export async function writeDelta(
  db: MailQuery,
  storageFor: TenantStorage,
  tenantId: string,
  delta: MailboxDelta,
): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  await writeSnapshot(db, storageFor, tenantId, applyDelta(await readSnapshot(db, tenantId), delta));
  // The full save this delta stands in for may still be on the wire, carrying an older copy of these
  // messages. Counting the delta as a server-side change makes that save lose for them, by the same rule
  // that keeps a scheduled release or a delivery report from being undone by an older tab.
  const ids = delta.upsert.map((message) => message.id);
  if (ids.length) {
    await db.query(`update cumulus_mail.messages set server_rev = server_rev + 1 where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids]);
  }
  return readSnapshot(db, tenantId);
}

export async function writeSnapshot(
  db: MailQuery,
  storageFor: TenantStorage,
  tenantId: string,
  snapshot: MailboxSnapshot,
): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  const current = await readSnapshot(db, tenantId);
  const limits = current.me.limits ?? limitsFor(DEFAULT_PLAN);
  if (snapshot.messages.length > limits.messages) throw new Error("Mailbox is too large");
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

  // A message the server changed after this client last loaded it (a scheduled send released, a delivery
  // report, an IMAP move: each bumps its rev) keeps the server's version; the client's copy is stale.
  // Without knownRevs (an older client) the client's copy is written, as before.
  const serverRevs = current.revs ?? {};
  const knownRevs = isRevMap(snapshot.knownRevs) ? snapshot.knownRevs : null;
  const serverWins = new Set<string>();
  if (knownRevs) {
    for (const [id, rev] of Object.entries(serverRevs)) if (rev > (knownRevs[id] ?? 0)) serverWins.add(id);
  }

  // Mail in a folder the saved settings no longer list goes back to the Inbox.
  const folders = sanitizeSettings(snapshot.settings).folders;
  for (const incoming of reconcileFolders(releaseDue(snapshot.messages), folders)) {
    if (serverWins.has(incoming.id)) continue;
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

  // Mail the client never saw (it arrived after the client loaded: inbound, a delivery from another
  // mailbox, a scheduled release) is kept as it is on the server. Only a message the client knew about
  // and left out is deleted. Without knownIds (an older client) the save replaces the mailbox, as before.
  const kept = new Set(messages.map((message) => message.id));
  const keepServerCopy = (message: MailMessage) => {
    messages.push(message);
    kept.add(message.id);
    keptRaw.set(message.id, rawKeys.get(message.id) ?? null);
    for (const file of existing.get(message.id) ?? []) storedFiles.push({ messageId: message.id, file });
  };
  if (Array.isArray(snapshot.knownIds)) {
    const known = new Set(snapshot.knownIds);
    for (const message of current.messages) {
      if (kept.has(message.id) || known.has(message.id)) continue;
      keepServerCopy(message);
    }
  }
  // The server's newer version of a message the client sent (or left out) stale.
  for (const message of current.messages) {
    if (serverWins.has(message.id) && !kept.has(message.id)) keepServerCopy(message);
  }

  // Refuse rather than silently keep the first few.
  if (requestedDomainCount(snapshot.settings, mailDomain()) > limits.domains) {
    throw new Error(`You can add up to ${limits.domains} custom domains.`);
  }
  if (sanitizeSettings(snapshot.settings).folders.length > limits.folders) {
    throw new Error(`You can have up to ${limits.folders} folders.`);
  }

  const aliases = await checkedAliases(db, tenantId, current, snapshot.aliases);

  const { knownIds: _known, knownRevs: _knownRevs, revs: _revs, ...rest } = snapshot;
  const next: MailboxSnapshot = {
    ...rest,
    // Only the display name comes from the client (first-run setup); address, plan and quota never do.
    me: { ...current.me, name: cleanDisplayName(snapshot.me?.name) || current.me.name },
    messages,
    aliases,
    signature: snapshot.signature.slice(0, 4000),
    rules: snapshot.rules.filter((rule) => rule.action === "star" || rule.action === "archive" || rule.action === "label"),
  };
  const before = await blobIds(db, tenantId);
  await replaceMailboxContents(db, tenantId, next, storedFiles, keptRaw, serverRevs);
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

/** A display name as stored: one line, no quotes or angle brackets (they would break a From header). */
export function cleanDisplayName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t"<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
}
