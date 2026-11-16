/**
 * IMAP UID semantics over the app's string message ids (docs/imap-bridge.md S2).
 *
 * A client caches messages by UID, so the rules are strict:
 *   - a UID is assigned once per (mailbox, folder, message) and is never reused, even after a delete;
 *   - `uidvalidity` identifies the numbering. It changes only if the numbering is rebuilt, which tells
 *     every client to drop its cache for that folder;
 *   - `modseq` rises on every change, so a client can ask "what changed since N" instead of re-reading;
 *   - a message moved to another folder is an expunge there and a new UID here, as IMAP expects.
 */
import { assertTenantId } from "../../storage/adapter.ts";
import type { MailQuery } from "../query.ts";

export type FolderState = { folder: string; uidvalidity: number; uidNext: number; modseq: number };

export type UidRow = { uid: number; messageId: string; modseq: number; expunged: boolean };

const n = (value: number | string | null | undefined): number => Number(value ?? 0);

/** The folder's numbering, started on first use. `uidvalidity` is the creation time in seconds. */
export async function folderState(db: MailQuery, tenantId: string, folder: string, now = new Date()): Promise<FolderState> {
  assertTenantId(tenantId);
  const rows = await db.query<{ uidvalidity: number | string; uid_next: number | string; modseq: number | string }>(
    `insert into cumulus_mail.bridge_folders (tenant_id, folder, uidvalidity, uid_next, modseq)
     values ($1, $2, $3, 1, 0)
     on conflict (tenant_id, folder) do update set folder = excluded.folder
     returning uidvalidity, uid_next, modseq`,
    [tenantId, folder, Math.floor(now.getTime() / 1000)],
  );
  const row = rows[0];
  return { folder, uidvalidity: n(row?.uidvalidity), uidNext: n(row?.uid_next), modseq: n(row?.modseq) };
}

/**
 * Record that a message is in a folder now, and return its UID. Called after a message is written.
 * An unchanged message keeps its UID; its modseq rises so clients re-fetch the flags.
 */
export async function touchMessage(db: MailQuery, tenantId: string, folder: string, messageId: string, now = new Date()): Promise<number> {
  assertTenantId(tenantId);
  await folderState(db, tenantId, folder, now);
  const bumped = await db.query<{ modseq: number | string; uid_next: number | string }>(
    `update cumulus_mail.bridge_folders set modseq = modseq + 1 where tenant_id = $1 and folder = $2
     returning modseq, uid_next`,
    [tenantId, folder],
  );
  const modseq = n(bumped[0]?.modseq);
  const existing = await db.query<{ uid: number | string }>(
    `update cumulus_mail.message_uids set modseq = $4, expunged = false
     where tenant_id = $1 and folder = $2 and message_id = $3
     returning uid`,
    [tenantId, folder, messageId, modseq],
  );
  if (existing[0]) return n(existing[0].uid);
  // New in this folder: take uid_next and move it on, in one statement so two writers cannot collide.
  const claimed = await db.query<{ uid_next: number | string }>(
    `update cumulus_mail.bridge_folders set uid_next = uid_next + 1 where tenant_id = $1 and folder = $2
     returning uid_next - 1 as uid_next`,
    [tenantId, folder],
  );
  const uid = n(claimed[0]?.uid_next ?? bumped[0]?.uid_next);
  await db.query(
    `insert into cumulus_mail.message_uids (tenant_id, folder, uid, message_id, modseq, expunged)
     values ($1,$2,$3,$4,$5,false)
     on conflict (tenant_id, folder, uid) do update set message_id = excluded.message_id, modseq = excluded.modseq, expunged = false`,
    [tenantId, folder, uid, messageId, modseq],
  );
  return uid;
}

/** Mark a message gone from a folder (deleted, or moved away). The UID is burned, never reused. */
export async function expungeMessage(db: MailQuery, tenantId: string, folder: string, messageId: string): Promise<void> {
  assertTenantId(tenantId);
  const bumped = await db.query<{ modseq: number | string }>(
    `update cumulus_mail.bridge_folders set modseq = modseq + 1 where tenant_id = $1 and folder = $2 returning modseq`,
    [tenantId, folder],
  );
  if (!bumped[0]) return; // the folder has never been synced: nothing to expunge
  await db.query(
    `update cumulus_mail.message_uids set expunged = true, modseq = $4
     where tenant_id = $1 and folder = $2 and message_id = $3`,
    [tenantId, folder, messageId, n(bumped[0].modseq)],
  );
}

/** Rows in the folder that changed after `sinceModseq`, oldest change first. */
export async function changesSince(
  db: MailQuery,
  tenantId: string,
  folder: string,
  sinceModseq: number,
  limit: number,
): Promise<UidRow[]> {
  assertTenantId(tenantId);
  const rows = await db.query<{ uid: number | string; message_id: string; modseq: number | string; expunged: boolean }>(
    `select uid, message_id, modseq, expunged
     from cumulus_mail.message_uids
     where tenant_id = $1 and folder = $2 and modseq > $3
     order by modseq, uid
     limit $4`,
    [tenantId, folder, Math.max(0, Math.floor(sinceModseq)), Math.max(1, Math.floor(limit))],
  );
  return rows.map((r) => ({ uid: n(r.uid), messageId: r.message_id, modseq: n(r.modseq), expunged: r.expunged }));
}

/**
 * Bring a folder's UID rows in line with the messages a mailbox now holds. Called after a snapshot
 * write, which replaces the whole mailbox: a message that is still there keeps its UID, one that is
 * gone (deleted, or moved to another folder) is expunged, and a new one takes the next UID.
 *
 * Does nothing while `MAIL_BRIDGE` is off, so a deployment without the bridge writes no bridge rows.
 */
export async function syncUidsForMailbox(
  db: MailQuery,
  tenantId: string,
  messages: Array<{ id: string; folder: string }>,
  options: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<void> {
  const { bridgeEnabled } = await import("./config.ts");
  if (!bridgeEnabled(options.env ?? process.env)) return;
  assertTenantId(tenantId);
  const byFolder = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!byFolder.has(message.folder)) byFolder.set(message.folder, new Set());
    byFolder.get(message.folder)!.add(message.id);
  }
  const known = await db.query<{ folder: string; message_id: string; expunged: boolean }>(
    `select folder, message_id, expunged from cumulus_mail.message_uids where tenant_id = $1`,
    [tenantId],
  );
  for (const [folder, ids] of byFolder) {
    for (const id of ids) await touchMessage(db, tenantId, folder, id, options.now);
  }
  for (const row of known) {
    if (row.expunged) continue;
    if (!byFolder.get(row.folder)?.has(row.message_id)) await expungeMessage(db, tenantId, row.folder, row.message_id);
  }
}

/**
 * Give one newly written message its UID (inbound mail, an APPEND). The snapshot path reconciles a
 * whole mailbox; this is for writes that add a single message without one. A no-op while MAIL_BRIDGE
 * is off.
 */
export async function noteNewMessage(
  db: MailQuery,
  tenantId: string,
  folder: string,
  messageId: string,
  options: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<number | null> {
  const { bridgeEnabled } = await import("./config.ts");
  if (!bridgeEnabled(options.env ?? process.env)) return null;
  return touchMessage(db, tenantId, folder, messageId, options.now);
}
