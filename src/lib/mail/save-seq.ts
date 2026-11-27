import type { MailQuery } from "./query.ts";

/**
 * Save ordering per open tab (migrations/0024_save_sequences.sql). Each page load picks a random tab id
 * and numbers its saves (store.ts `revision`). A save is written only if its number is above the highest
 * one the server has applied for that tab, so an older request that arrives late (a full save that was
 * still on the wire when the tab closed and sent its delta) is dropped instead of undoing newer state.
 * Saves without a tag (older clients) are written as before.
 */
export type SaveTag = { tab: string; seq: number };

const TAB = /^[A-Za-z0-9-]{8,64}$/;

/** A well-formed tag, or undefined when there is none. A malformed one is refused. */
export function asSaveTag(tab: unknown, seq: unknown): SaveTag | undefined {
  if (tab === undefined && seq === undefined) return undefined;
  if (typeof tab !== "string" || !TAB.test(tab) || !Number.isSafeInteger(seq) || (seq as number) < 0) {
    throw new Error("Invalid save tag");
  }
  return { tab, seq: seq as number };
}

/**
 * Records this save as the tab's newest and says whether to write it. False when the tab already had an
 * equal or newer save applied. True when the table does not exist yet (0024 not applied).
 */
export async function claimSave(db: MailQuery, tenantId: string, tag: SaveTag): Promise<boolean> {
  try {
    const rows = await db.query<{ seq: string | number }>(
      `insert into cumulus_mail.save_sequences (tenant_id, tab_id, seq, updated_at) values ($1, $2, $3, now())
       on conflict (tenant_id, tab_id) do update set seq = excluded.seq, updated_at = now()
       where cumulus_mail.save_sequences.seq < excluded.seq
       returning seq`,
      [tenantId, tag.tab, tag.seq],
    );
    if (rows.length && Math.random() < 0.05) {
      await db.query(`delete from cumulus_mail.save_sequences where tenant_id = $1 and updated_at < now() - interval '7 days'`, [tenantId]);
    }
    return rows.length > 0;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return true;
    throw error;
  }
}

/** A save another, newer save from the same tab overtook while it was being processed. */
export class StaleSaveError extends Error {
  constructor() {
    super("A newer save from this tab was applied first");
    this.name = "StaleSaveError";
  }
}

/**
 * Inside the transaction that writes the mailbox: locks the tab's row and throws StaleSaveError when a
 * newer save from the same tab claimed it since this one did. The claim at the start of a save refuses
 * what is already late; this catches a save that was overtaken while it read, checked and stored files.
 * Does nothing when 0024 is not applied (checked first, so no failed statement aborts the transaction).
 */
export async function assertStillNewest(db: MailQuery, tenantId: string, tag: SaveTag): Promise<void> {
  const [table] = await db.query<{ t: string | null }>(`select to_regclass('cumulus_mail.save_sequences')::text as t`);
  if (!table?.t) return;
  const rows = await db.query<{ seq: string | number }>(
    `select seq from cumulus_mail.save_sequences where tenant_id = $1 and tab_id = $2 for update`,
    [tenantId, tag.tab],
  );
  if (rows[0] && Number(rows[0].seq) > tag.seq) throw new StaleSaveError();
}
