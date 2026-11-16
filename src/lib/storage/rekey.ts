/**
 * Move stored values to the current key (`npm run keys:rekey`; docs/design/blob-key-rotation.md).
 *
 * **Dry run by default:** it counts what is sealed under which key and changes nothing. `apply: true`
 * re-seals every value that is not under the current key.
 *
 * - **Sealed fields** are found generically: every text column of every `cumulus_mail` table with a
 *   `tenant_id`, value starting `cm1.`. A table added later is covered without editing this file.
 *   Each value is rewritten with a compare-and-swap on its old ciphertext, so a concurrent write wins.
 * - **Blobs** are found through the rows that point at them (raw messages, attachments, shared blobs)
 *   and rewritten in place under the same id; the drivers replace objects atomically.
 * - **Resumable and idempotent:** mailboxes are processed in id order, in batches; `fromTenant` starts
 *   after a given mailbox, and a value already under the current key is skipped, so re-running after a
 *   stop, or twice, is safe.
 *
 * Blind indexes are not touched: they stay on the stable key (keyring.ts, `blindKeyFromEnv`).
 */
import type { StorageDriver } from "./driver.ts";
import { resealed, sealedKeyId, type Keyring } from "./keyring.ts";

type Query = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

const FIELD_PREFIX = "cm1.";
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** byKey: values per key id. failed: values whose key is not in the ring (left as they are, reported). */
export type Tally = { scanned: number; byKey: Record<string, number>; resealed: number; failed: number };
export type RekeyReport = {
  applied: boolean;
  currentKey: number;
  mailboxes: number;
  lastTenant: string | null;
  fields: Tally;
  blobs: Tally & { missing: number };
};

const tally = (): Tally => ({ scanned: 0, byKey: {}, resealed: 0, failed: 0 });

/** Re-seal one value, or null when it is current; counts a value it cannot open instead of stopping. */
function tryReseal(t: Tally, ring: Keyring, tenantId: string, sealed: Uint8Array, purpose: string): Uint8Array | null {
  try {
    return resealed(ring, tenantId, sealed, purpose);
  } catch {
    t.failed += 1;
    return null;
  }
}
const count = (t: Tally, keyId: number | null) => {
  t.scanned += 1;
  const label = keyId === null ? "unreadable" : String(keyId);
  t.byKey[label] = (t.byKey[label] ?? 0) + 1;
};

/** Every (table, text columns) in cumulus_mail that belongs to a mailbox. */
async function sealedColumns(db: Query): Promise<Array<{ table: string; columns: string[] }>> {
  const rows = await db.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'cumulus_mail' and t.table_type = 'BASE TABLE'
        and c.data_type in ('text', 'character varying')
        and exists (select 1 from information_schema.columns k
                     where k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = 'tenant_id')
      order by c.table_name, c.column_name`,
    [],
  );
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    if (!IDENT.test(row.table_name) || !IDENT.test(row.column_name) || row.column_name === "tenant_id") continue;
    byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
  }
  return [...byTable].map(([table, columns]) => ({ table, columns }));
}

async function blobIds(db: Query, tenantId: string): Promise<string[]> {
  const rows = await db.query<{ key: string | null }>(
    `select raw_key as key from cumulus_mail.messages where tenant_id = $1 and raw_key is not null
     union select object_key from cumulus_mail.attachments where tenant_id = $1
     union select blob_id from cumulus_mail.share_grants where tenant_id = $1`,
    [tenantId],
  );
  return [...new Set(rows.map((r) => r.key).filter((k): k is string => Boolean(k)))];
}

export async function rekey(
  db: Query,
  driver: StorageDriver,
  ring: Keyring,
  options: { apply?: boolean; batchSize?: number; fromTenant?: string; onProgress?: (report: RekeyReport) => void } = {},
): Promise<RekeyReport> {
  if (!ring.keys.has(ring.current)) throw new Error("The current key is missing from the keyring");
  const apply = options.apply === true;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 1000));
  const report: RekeyReport = {
    applied: apply,
    currentKey: ring.current,
    mailboxes: 0,
    lastTenant: null,
    fields: tally(),
    blobs: { ...tally(), missing: 0 },
  };
  const tables = await sealedColumns(db);
  let after = options.fromTenant ?? "";
  for (;;) {
    const batch = await db.query<{ tenant_id: string }>(
      `select tenant_id from cumulus_mail.mailboxes where tenant_id > $1 order by tenant_id limit $2`,
      [after, batchSize],
    );
    if (!batch.length) break;
    for (const { tenant_id: tenantId } of batch) {
      // Fields.
      for (const { table, columns } of tables) {
        const rows = await db.query<Record<string, string | null>>(
          `select ctid::text as row_ctid, ${columns.join(", ")} from cumulus_mail.${table} where tenant_id = $1`,
          [tenantId],
        );
        for (const row of rows) {
          const changes: Array<{ column: string; from: string; to: string }> = [];
          for (const column of columns) {
            const value = row[column];
            if (typeof value !== "string" || !value.startsWith(FIELD_PREFIX)) continue;
            const sealed = new Uint8Array(Buffer.from(value.slice(FIELD_PREFIX.length), "base64url"));
            count(report.fields, sealedKeyId(sealed));
            if (!apply) continue;
            const next = tryReseal(report.fields, ring, tenantId, sealed, "meta");
            if (next) changes.push({ column, from: value, to: FIELD_PREFIX + Buffer.from(next).toString("base64url") });
          }
          if (!changes.length) continue;
          // One statement per row: an update gives the row a new ctid, so per-column updates would miss.
          // Compare-and-swap on every old value: if the app changed the row meanwhile, nothing is written
          // and the values stay counted as not yet current, for the next run.
          const params: unknown[] = [row.row_ctid];
          const set = changes.map((c) => `${c.column} = $${params.push(c.to)}`).join(", ");
          const same = changes.map((c) => `${c.column} = $${params.push(c.from)}`).join(" and ");
          const updated = await db.query(
            `update cumulus_mail.${table} set ${set} where ctid = $1::tid and ${same} returning 1 as ok`,
            params,
          );
          if (updated.length) report.fields.resealed += changes.length;
        }
      }
      // Blobs.
      for (const blobId of await blobIds(db, tenantId)) {
        let sealed: Uint8Array;
        try {
          sealed = await driver.get(tenantId, blobId);
        } catch {
          report.blobs.missing += 1;
          continue;
        }
        count(report.blobs, sealedKeyId(sealed));
        if (!apply) continue;
        const next = tryReseal(report.blobs, ring, tenantId, sealed, "blob");
        if (!next) continue;
        await driver.put(tenantId, blobId, next);
        report.blobs.resealed += 1;
      }
      report.mailboxes += 1;
      report.lastTenant = tenantId;
    }
    after = batch[batch.length - 1]!.tenant_id;
    options.onProgress?.(report);
  }
  return report;
}

/**
 * Values still not under the current key after this run: everything counted under another key, minus
 * what was re-sealed. 0 after an applied run means the old keys can be retired.
 */
export function notYetCurrent(report: RekeyReport): number {
  const remaining = (t: Tally) =>
    Object.entries(t.byKey).reduce((n, [key, v]) => (key === String(report.currentKey) ? n : n + v), 0) - t.resealed;
  return remaining(report.fields) + remaining(report.blobs);
}
