/**
 * Orphan blobs: stored bytes that no row points at any more. Normal operation leaves none, but a crash
 * between writing a blob and its row, or a delete that removed rows but not bytes, can. Account
 * deletion (account-deletion.ts) can only find blobs through rows, so this is how the rest are found.
 *
 * **Dry run by default**: it reports what it would delete and deletes nothing. `apply: true` deletes.
 * A blob younger than `minAgeMs` (default a day) is never touched: it may belong to a write that is
 * still in progress, whose row is not there yet.
 */
import type { StorageDriver, StoredBlob } from "../storage/driver.ts";
import type { MailQuery } from "./query.ts";

export const DEFAULT_MIN_AGE_MS = 24 * 3_600_000;
/** Tenants the health checks write to and remove at once. Never mail. */
const PROBE_TENANTS = new Set(["probe", "health-probe"]);

export type SweepReport = {
  applied: boolean;
  scanned: number;
  referenced: number;
  tooNew: number;
  orphans: Array<{ tenantId: string; blobId: string; size: number; modifiedAt: string }>;
  orphanBytes: number;
  deleted: number;
  /** Per tenant, so an operator can see whether one mailbox or many are affected. */
  byTenant: Record<string, { count: number; bytes: number }>;
};

/** Every blob a row points at, as `tenant/blob`. */
export async function referencedBlobs(db: MailQuery): Promise<Set<string>> {
  const rows = await db.query<{ tenant_id: string; key: string | null }>(
    `select tenant_id, raw_key as key from cumulus_mail.messages where raw_key is not null
     union all select tenant_id, object_key from cumulus_mail.attachments
     union all select tenant_id, blob_id from cumulus_mail.share_grants`,
    [],
  );
  return new Set(rows.filter((row) => row.key).map((row) => `${row.tenant_id}/${row.key}`));
}

export async function sweepOrphanBlobs(
  db: MailQuery,
  driver: StorageDriver,
  options: { apply?: boolean; minAgeMs?: number; now?: Date } = {},
): Promise<SweepReport> {
  if (!driver.list) throw new Error(`The ${driver.kind} storage driver cannot list blobs, so orphans cannot be found.`);
  const apply = options.apply === true;
  const minAge = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const now = (options.now ?? new Date()).getTime();
  const referenced = await referencedBlobs(db);
  const report: SweepReport = { applied: apply, scanned: 0, referenced: 0, tooNew: 0, orphans: [], orphanBytes: 0, deleted: 0, byTenant: {} };
  const candidates: StoredBlob[] = [];
  for await (const blob of driver.list()) {
    report.scanned += 1;
    if (PROBE_TENANTS.has(blob.tenantId)) continue;
    if (referenced.has(`${blob.tenantId}/${blob.blobId}`)) {
      report.referenced += 1;
      continue;
    }
    if (now - blob.modifiedAt.getTime() < minAge) {
      report.tooNew += 1;
      continue;
    }
    candidates.push(blob);
  }
  for (const blob of candidates) {
    report.orphans.push({ tenantId: blob.tenantId, blobId: blob.blobId, size: blob.size, modifiedAt: blob.modifiedAt.toISOString() });
    report.orphanBytes += blob.size;
    const tenant = (report.byTenant[blob.tenantId] ??= { count: 0, bytes: 0 });
    tenant.count += 1;
    tenant.bytes += blob.size;
    if (apply) {
      await driver.delete(blob.tenantId, blob.blobId);
      report.deleted += 1;
    }
  }
  return report;
}
