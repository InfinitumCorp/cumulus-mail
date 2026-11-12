import { assertTenantId } from "../storage/adapter.ts";
import { deliverPending, type TenantStorage } from "./delivery.ts";
import { blindIndex, sealText } from "./field-crypto.ts";
import type { MailQuery } from "./query.ts";
import { withTransaction } from "./query.ts";
import { dueHour, readMessages, readProfile } from "./records.ts";
import { releaseDue, sanitizeExtra } from "./schedule.ts";

export type ReleaseReport = {
  /** Tenants that had a candidate draft or undelivered sent message. */
  tenants: number;
  /** Scheduled drafts moved to Sent. */
  released: number;
  /** Tenants whose release or delivery threw. The others still ran. */
  failed: number;
};

/**
 * Server-side scheduled send. Runs without an open tab (the inbound worker's
 * cron calls it). For each tenant with a draft that may carry a schedule, or a
 * sent message with no delivery yet:
 *   1. move drafts whose `scheduleAt` has passed to Sent, and
 *   2. run the same `deliverPending` a save runs, which also releases expired
 *      undo holds.
 *
 * A draft is moved only when its stored row has not changed since it was read
 * (same folder and same sealed extras), so an edit made in the app between the
 * read and the write wins: that draft waits for the next run.
 */
export async function releaseScheduledMail(
  db: MailQuery,
  storageFor: TenantStorage,
  now = Date.now(),
): Promise<ReleaseReport> {
  // Drafts are found by the coarse due column (an index range, no decryption). Drafts saved before
  // that column existed have it NULL; they are picked up once and backfilled.
  const rows = await db.query<{ tenant_id: string }>(
    `select distinct m.tenant_id from cumulus_mail.messages m
     where (m.folder = 'drafts' and (m.due_at <= $1 or (m.due_at is null and m.extras_enc is not null)))
        or (m.folder = 'sent' and not exists (
              select 1 from cumulus_mail.deliveries d
              where d.sender_tenant = m.tenant_id and d.message_id = m.id))
     order by m.tenant_id`,
    [new Date(now).toISOString()],
  );
  const report: ReleaseReport = { tenants: rows.length, released: 0, failed: 0 };
  for (const { tenant_id: tenantId } of rows) {
    try {
      report.released += await releaseTenant(db, tenantId, now);
      await deliverPending(db, storageFor, tenantId);
    } catch (error) {
      report.failed += 1;
      const message = error instanceof Error ? error.message : "release failed";
      console.error(
        JSON.stringify({
          event: "mail.schedule.failed",
          error: /postgres(ql)?:\/\//i.test(message) ? "release failed" : message.slice(0, 300),
        }),
      );
    }
  }
  return report;
}

async function releaseTenant(db: MailQuery, tenantId: string, now: number): Promise<number> {
  assertTenantId(tenantId);
  const sealed = await db.query<{ id: string; extras_enc: string | null; due_at: string | null }>(
    `select id, extras_enc, due_at from cumulus_mail.messages
     where tenant_id = $1 and folder = 'drafts'
       and (due_at <= $2 or (due_at is null and extras_enc is not null))`,
    [tenantId, new Date(now).toISOString()],
  );
  if (sealed.length === 0) return 0;
  const before = new Map(sealed.map((row) => [row.id, row.extras_enc]));
  const drafts = (await readMessages(db, tenantId)).filter((message) => before.has(message.id));
  // One-time backfill for drafts saved before the due column existed (same row-unchanged guard).
  for (const draft of drafts) {
    if (sealed.find((row) => row.id === draft.id)?.due_at !== null) continue;
    await db.query(
      `update cumulus_mail.messages set due_at = $3
       where tenant_id = $1 and id = $2 and folder = 'drafts' and due_at is null and extras_enc = $4`,
      [tenantId, draft.id, dueHour(draft), before.get(draft.id)],
    );
  }
  const due = releaseDue(drafts, now).filter((message) => message.folder === "sent");
  if (due.length === 0) return 0;
  const me = await readProfile(db, tenantId);
  if (!me) return 0;

  let released = 0;
  for (const message of due) {
    const clean = sanitizeExtra(message.extra);
    const moved = await withTransaction(db, async () => {
      const updated = await db.query<{ id: string }>(
        `update cumulus_mail.messages
         set folder = 'sent', from_name = $3, from_email = $4, extras_enc = $5, due_at = null
         where tenant_id = $1 and id = $2 and folder = 'drafts' and extras_enc = $6
         returning id`,
        [
          tenantId,
          message.id,
          sealText(tenantId, me.name.slice(0, 200)),
          sealText(tenantId, me.email.slice(0, 320)),
          clean ? sealText(tenantId, JSON.stringify(clean)) : null,
          before.get(message.id),
        ],
      );
      if (updated.length === 0) return false;
      await db.query(
        `delete from cumulus_mail.message_blind where tenant_id = $1 and message_id = $2 and field = 'from'`,
        [tenantId, message.id],
      );
      await db.query(
        `insert into cumulus_mail.message_blind (tenant_id, message_id, field, bidx)
         values ($1, $2, 'from', $3) on conflict do nothing`,
        [tenantId, message.id, blindIndex(tenantId, "from", me.email.slice(0, 320))],
      );
      return true;
    });
    if (moved) released += 1;
  }
  return released;
}
