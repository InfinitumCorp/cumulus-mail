/**
 * Account deletion: the right to erasure (152-ФЗ ст. 21, GDPR art. 17).
 *
 *   request  ->  7-day grace period (cancel any time)  ->  hard delete
 *
 * The hard delete removes **every row in `cumulus_mail` that belongs to the mailbox** and every blob
 * those rows point at (raw messages, attachments, shared blobs). The tables are found from the schema
 * at run time — any table with a `tenant_id` or `sender_tenant` column — so a table added later (the
 * search index, bridge tokens, export history) is covered without editing this file, and a test proves
 * nothing is left.
 *
 * What survives is one `deletion_audit` row: when it was asked for, when it was done, how many rows
 * and blobs went. No content, no address, and the mailbox id only as an HMAC under a server key.
 */
import { createHmac, randomUUID } from "node:crypto";
import { assertTenantId } from "../storage/adapter.ts";
import type { TenantBlobs } from "../storage/index.ts";
import { withTransaction, type MailQuery } from "./query.ts";

export const GRACE_MS = 7 * 24 * 3_600_000;

/** Columns that tie a row to a mailbox. */
const TENANT_COLUMNS = ["tenant_id", "sender_tenant"] as const;
/** Tables that are about the deletion itself, handled separately. */
const BOOKKEEPING = new Set(["account_deletions", "deletion_audit"]);

export type DeletionStatus = { requestedAt: string; purgeAfter: string; cancelled: boolean } | null;

const iso = (value: string | Date) => new Date(value).toISOString();

/** Ask for deletion. Asking again while one is pending keeps the original date; after a cancel it restarts. */
export async function requestDeletion(db: MailQuery, tenantId: string, now = new Date()): Promise<{ purgeAfter: string }> {
  assertTenantId(tenantId);
  const purgeAfter = new Date(now.getTime() + GRACE_MS);
  const rows = await db.query<{ purge_after: string | Date }>(
    `insert into cumulus_mail.account_deletions (tenant_id, requested_at, purge_after)
     values ($1, $2, $3)
     on conflict (tenant_id) do update set
       requested_at = case when cumulus_mail.account_deletions.cancelled_at is null
                           then cumulus_mail.account_deletions.requested_at else excluded.requested_at end,
       purge_after  = case when cumulus_mail.account_deletions.cancelled_at is null
                           then cumulus_mail.account_deletions.purge_after else excluded.purge_after end,
       cancelled_at = null
     returning purge_after`,
    [tenantId, now.toISOString(), purgeAfter.toISOString()],
  );
  return { purgeAfter: iso(rows[0]!.purge_after) };
}

/** Cancel during the grace period. False when there was nothing pending. */
export async function cancelDeletion(db: MailQuery, tenantId: string, now = new Date()): Promise<boolean> {
  assertTenantId(tenantId);
  const rows = await db.query<{ tenant_id: string }>(
    `update cumulus_mail.account_deletions set cancelled_at = $2
     where tenant_id = $1 and cancelled_at is null returning tenant_id`,
    [tenantId, now.toISOString()],
  );
  return rows.length > 0;
}

export async function deletionStatus(db: MailQuery, tenantId: string): Promise<DeletionStatus> {
  assertTenantId(tenantId);
  const rows = await db.query<{ requested_at: string | Date; purge_after: string | Date; cancelled_at: string | Date | null }>(
    `select requested_at, purge_after, cancelled_at from cumulus_mail.account_deletions where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  return row ? { requestedAt: iso(row.requested_at), purgeAfter: iso(row.purge_after), cancelled: row.cancelled_at !== null } : null;
}

/** Every (table, column) in `cumulus_mail` that holds a mailbox id, mailboxes last. */
export async function tenantTables(db: MailQuery): Promise<Array<{ table: string; column: string }>> {
  const rows = await db.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'cumulus_mail' and t.table_type = 'BASE TABLE' and c.column_name = any($1)
      order by c.table_name, c.column_name`,
    [[...TENANT_COLUMNS]],
  );
  const found = rows
    // Names come from our own schema, but they are spliced into SQL: accept plain identifiers only.
    .filter((row) => /^[a-z_][a-z0-9_]*$/.test(row.table_name) && /^[a-z_][a-z0-9_]*$/.test(row.column_name))
    .filter((row) => !BOOKKEEPING.has(row.table_name))
    .map((row) => ({ table: row.table_name, column: row.column_name }));
  return [...found.filter((f) => f.table !== "mailboxes"), ...found.filter((f) => f.table === "mailboxes")];
}

/** Every blob the mailbox's rows point at. */
async function blobKeys(db: MailQuery, tenantId: string): Promise<string[]> {
  const rows = await db.query<{ key: string | null }>(
    `select raw_key as key from cumulus_mail.messages where tenant_id = $1 and raw_key is not null
     union select object_key from cumulus_mail.attachments where tenant_id = $1
     union select blob_id from cumulus_mail.share_grants where tenant_id = $1`,
    [tenantId],
  );
  return [...new Set(rows.map((row) => row.key).filter((key): key is string => Boolean(key)))];
}

export function subjectHmac(tenantId: string, env: Record<string, string | undefined> = process.env): string {
  const secret = env.MAIL_BLOB_KEY?.trim();
  if (!secret) throw new Error("MAIL_BLOB_KEY is not set");
  const key = createHmac("sha256", secret).update("cumulus-mail/deletion-audit/v1").digest();
  return createHmac("sha256", key).update(tenantId).digest("hex");
}

export type PurgeReport = { rows: number; blobs: number };

/**
 * Delete everything for one mailbox, now. Blobs first (deleting one that is already gone is fine, so a
 * retry after a failure is safe), then every row in one transaction, then the audit record.
 */
export async function purgeMailbox(db: MailQuery, storage: TenantBlobs, tenantId: string, now = new Date()): Promise<PurgeReport> {
  assertTenantId(tenantId);
  const status = await deletionStatus(db, tenantId);
  const keys = await blobKeys(db, tenantId);
  let blobs = 0;
  for (const key of keys) {
    await storage.delete(key).catch((error: { code?: string; name?: string }) => {
      if (error?.code !== "ENOENT" && error?.name !== "BlobNotFoundError" && error?.name !== "NoSuchKey") throw error;
    });
    blobs += 1;
  }
  const tables = await tenantTables(db);
  let rows = 0;
  await withTransaction(db, async () => {
    for (const { table, column } of tables) {
      const deleted = await db.query<{ n: number | string }>(
        `with gone as (delete from cumulus_mail.${table} where ${column} = $1 returning 1) select count(*) as n from gone`,
        [tenantId],
      );
      rows += Number(deleted[0]?.n ?? 0);
    }
    await db.query(`delete from cumulus_mail.account_deletions where tenant_id = $1`, [tenantId]);
    await db.query(
      `insert into cumulus_mail.deletion_audit (id, subject_hmac, requested_at, purged_at, rows_deleted, blobs_deleted)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), subjectHmac(tenantId), status?.requestedAt ?? now.toISOString(), now.toISOString(), rows, blobs],
    );
  });
  return { rows, blobs };
}

/** Purge every mailbox whose grace period has ended and was not cancelled. Run from the scheduler. */
export async function purgeDueDeletions(
  db: MailQuery,
  storageFor: (tenantId: string) => TenantBlobs,
  now = new Date(),
): Promise<{ purged: number }> {
  const due = await db.query<{ tenant_id: string }>(
    `select tenant_id from cumulus_mail.account_deletions
     where cancelled_at is null and purge_after <= $1
     order by purge_after limit 20`,
    [now.toISOString()],
  );
  let purged = 0;
  for (const { tenant_id } of due) {
    await purgeMailbox(db, storageFor(tenant_id), tenant_id, now);
    purged += 1;
  }
  return { purged };
}
