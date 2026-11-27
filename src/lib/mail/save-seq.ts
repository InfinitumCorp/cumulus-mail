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
