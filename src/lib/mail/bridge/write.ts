/**
 * Bridge writes, phase 2: IMAP MOVE (RFC 6851) and APPEND for sent copies. Off unless both
 * `MAIL_BRIDGE=on` and `MAIL_BRIDGE_WRITE=on`, and only for a token created with the write scope
 * (tokens.ts). Everything else IMAP can write (STORE flags, COPY, EXPUNGE, CREATE/DELETE/RENAME) is still
 * refused by the bridge.
 *
 * Deliberately narrow:
 * - MOVE never targets Drafts (a draft can carry a scheduled send) or Quarantine, and never takes mail out
 *   of Quarantine: releasing quarantined mail has its own checks (release.ts).
 * - APPEND only files into Sent, and only a message whose From is one of this mailbox's own addresses. It is
 *   for the copy a client keeps after sending through SMTP; it cannot be used to plant "received" mail.
 */
import { createHash } from "node:crypto";
import { assertTenantId } from "../../storage/adapter.ts";
import type { TenantStorage } from "../delivery.ts";
import { findTenantByAddress } from "../directory.ts";
import { overQuotaWith } from "../inbound.ts";
import { parseMime } from "../mime.ts";
import type { MailMessage } from "../model.ts";
import type { MailQuery } from "../query.ts";
import { insertAttachment, insertMessage, readSettings } from "../records.ts";
import { appendMaxBytes } from "./config.ts";
import { expungeMessage, folderState, touchMessage } from "./uids.ts";
import { isCustomFolderId, isSystemFolderId } from "../folders.ts";

export type BridgeWriteCode = "bad_folder" | "not_allowed" | "too_large" | "not_own_address" | "mailbox_full" | "bad_message";

export class BridgeWriteError extends Error {
  readonly code: BridgeWriteCode;
  constructor(code: BridgeWriteCode, message: string) {
    super(message);
    this.code = code;
    this.name = "BridgeWriteError";
  }
}

const MOVE_TARGETS_REFUSED = new Set(["drafts", "quarantine"]);
const MAX_MOVE = 500;

/** A folder this mailbox has: a system folder, or a custom folder that exists in its settings. */
async function knownFolder(db: MailQuery, tenantId: string, folder: string): Promise<boolean> {
  if (isSystemFolderId(folder)) return true;
  if (!isCustomFolderId(folder)) return false;
  const settings = await readSettings(db, tenantId);
  return settings.folders.some((f) => f.id === folder);
}

export type MoveResult = {
  /** UIDVALIDITY of the destination, for the COPYUID response code. */
  uidvalidity: number;
  /** [source UID, destination UID] for each message moved. UIDs not in the source are left out. */
  moved: Array<[number, number]>;
};

export async function moveMessages(
  db: MailQuery,
  tenantId: string,
  request: { from: string; to: string; uids: number[] },
  options: { now?: Date } = {},
): Promise<MoveResult> {
  assertTenantId(tenantId);
  const { from, to } = request;
  if (!(await knownFolder(db, tenantId, from)) || !(await knownFolder(db, tenantId, to))) {
    throw new BridgeWriteError("bad_folder", "Unknown folder.");
  }
  if (from === "quarantine" || MOVE_TARGETS_REFUSED.has(to)) {
    throw new BridgeWriteError("not_allowed", "Messages cannot be moved into Drafts or Quarantine, or out of Quarantine, through the bridge.");
  }
  const uids = [...new Set(request.uids.filter((u) => Number.isSafeInteger(u) && u > 0))].slice(0, MAX_MOVE);
  const state = await folderState(db, tenantId, to, options.now);
  if (from === to || uids.length === 0) return { uidvalidity: state.uidvalidity, moved: [] };

  const rows = await db.query<{ uid: number | string; message_id: string }>(
    `select u.uid, u.message_id
       from cumulus_mail.message_uids u
       join cumulus_mail.messages m on m.tenant_id = u.tenant_id and m.id = u.message_id and m.folder = u.folder
      where u.tenant_id = $1 and u.folder = $2 and u.expunged = false and u.uid = any($3::bigint[])
      order by u.uid`,
    [tenantId, from, uids],
  );
  const moved: Array<[number, number]> = [];
  for (const row of rows) {
    // Compare-and-swap on the folder: if the app moved it meanwhile, this message is skipped.
    const updated = await db.query<{ id: string }>(
      `update cumulus_mail.messages
          set folder = $4, due_at = case when $3 = 'drafts' then null else due_at end
        where tenant_id = $1 and id = $2 and folder = $3
        returning id`,
      [tenantId, row.message_id, from, to],
    );
    if (!updated.length) continue;
    await expungeMessage(db, tenantId, from, row.message_id);
    moved.push([Number(row.uid), await touchMessage(db, tenantId, to, row.message_id, options.now)]);
  }
  return { uidvalidity: state.uidvalidity, moved };
}

export type AppendResult = { uidvalidity: number; uid: number; messageId: string; duplicate: boolean };

/**
 * File a sent copy. The same bytes appended twice (a client retrying) give the same message and UID.
 * `seen` defaults to true, as a sent copy is never unread.
 */
export async function appendSentCopy(
  db: MailQuery,
  storageFor: TenantStorage,
  tenantId: string,
  request: { folder: string; raw: Uint8Array; seen?: boolean; flagged?: boolean },
  options: { env?: Record<string, string | undefined>; enforceStorage?: boolean; now?: Date } = {},
): Promise<AppendResult> {
  assertTenantId(tenantId);
  if (request.folder !== "sent") {
    throw new BridgeWriteError("not_allowed", "The bridge appends only to Sent (copies of mail sent through SMTP).");
  }
  const max = appendMaxBytes(options.env ?? process.env);
  if (request.raw.byteLength === 0) throw new BridgeWriteError("bad_message", "Empty message.");
  if (request.raw.byteLength > max) throw new BridgeWriteError("too_large", `Messages over ${max} bytes are refused.`);

  const digest = createHash("sha256").update(request.raw).digest("hex");
  const id = `ap-${digest.slice(0, 32)}`;
  const state = await folderState(db, tenantId, "sent", options.now);
  const existing = await db.query<{ uid: number | string }>(
    `select u.uid from cumulus_mail.messages m
       join cumulus_mail.message_uids u on u.tenant_id = m.tenant_id and u.message_id = m.id and u.folder = m.folder
      where m.tenant_id = $1 and m.id = $2 and u.expunged = false`,
    [tenantId, id],
  );
  if (existing[0]) return { uidvalidity: state.uidvalidity, uid: Number(existing[0].uid), messageId: id, duplicate: true };

  const parsed = parseMime(request.raw);
  const fromAddress = parsed.from.email.trim().toLowerCase();
  if (!fromAddress) throw new BridgeWriteError("bad_message", "The message has no From address.");
  if ((await findTenantByAddress(db, fromAddress)) !== tenantId) {
    throw new BridgeWriteError("not_own_address", "A sent copy must be from one of this mailbox's own addresses.");
  }
  if (options.enforceStorage && (await overQuotaWith(db, tenantId, request.raw.byteLength))) {
    throw new BridgeWriteError("mailbox_full", "The mailbox is full.");
  }

  const storage = storageFor(tenantId);
  const rawSaved = await storage.put(request.raw);
  const attachments = [];
  for (const [index, file] of parsed.attachments.entries()) {
    const saved = await storage.put(file.bytes);
    attachments.push({
      id: `a-${id}-${index}`,
      name: file.name,
      size: file.bytes.byteLength,
      contentType: file.contentType || "application/octet-stream",
      sha256: saved.sha256,
      objectKey: saved.blobId,
    });
  }
  const dated = Date.parse(parsed.headers.date ?? "");
  const message: MailMessage = {
    id,
    threadId: id,
    folder: "sent",
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject || "(no subject)",
    body: parsed.text.slice(0, 1_000_000),
    at: new Date(Number.isFinite(dated) ? dated : (options.now ?? new Date()).getTime()).toISOString(),
    unread: request.seen === false,
    starred: request.flagged === true,
    labels: [],
    attachments: attachments.map(({ objectKey: _objectKey, ...file }) => file),
    headers: parsed.headers,
  };
  await insertMessage(db, tenantId, message, rawSaved.blobId);
  for (const file of attachments) await insertAttachment(db, tenantId, id, file);
  const uid = await touchMessage(db, tenantId, "sent", id, options.now);
  return { uidvalidity: state.uidvalidity, uid, messageId: id, duplicate: false };
}
