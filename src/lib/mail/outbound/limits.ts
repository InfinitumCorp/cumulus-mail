import { assertTenantId } from "../../storage/adapter.ts";
import type { MailQuery } from "../query.ts";

/**
 * Per-mailbox sending limits for outside mail (recipients, not messages). Once SMTP is on, a
 * compromised or abusive mailbox could otherwise push unlimited mail through the relay and get the
 * domain blocklisted.
 *
 *   MAIL_OUTBOUND_HOURLY_LIMIT  default 100. Over it, mail is still queued but goes out later.
 *   MAIL_OUTBOUND_DAILY_LIMIT   default 500. Over it, mail is held and not queued.
 */
export type SendLimits = { hourly: number; daily: number };

export const DEFAULT_LIMITS: SendLimits = { hourly: 100, daily: 500 };

function positive(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : fallback;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SendLimits {
  return {
    hourly: positive(env.MAIL_OUTBOUND_HOURLY_LIMIT, DEFAULT_LIMITS.hourly),
    daily: positive(env.MAIL_OUTBOUND_DAILY_LIMIT, DEFAULT_LIMITS.daily),
  };
}

export type SendDecision =
  | { action: "send"; at: Date }
  | { action: "later"; at: Date }
  | { action: "hold"; reason: string };

/**
 * Decide when one more outside recipient can go: now, later (the hour is full; it goes out when the
 * oldest send in that hour is an hour old), or not at all today (the day is full).
 */
export async function sendDecision(db: MailQuery, tenantId: string, limits: SendLimits, now = new Date()): Promise<SendDecision> {
  assertTenantId(tenantId);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const rows = await db.query<{ day: number | string; scheduled: string[] | null }>(
    `select count(*) as day,
            array_agg(next_attempt_at order by next_attempt_at desc) filter (where next_attempt_at > $3) as scheduled
     from cumulus_mail.outbound_queue
     where tenant_id = $1 and created_at > $2`,
    [tenantId, dayAgo, new Date(now.getTime() - 3_600_000).toISOString()],
  );
  const day = Number(rows[0]?.day ?? 0);
  if (day >= limits.daily) {
    return { action: "hold", reason: `Held in the outbox. Daily sending limit reached (${limits.daily} outside recipients a day).` };
  }
  // Rows already scheduled in the last hour or later, newest first. The hour has room when fewer than
  // `hourly` sends fall inside any one-hour window ending at the new send's time.
  const scheduled = (rows[0]?.scheduled ?? []).map((value) => new Date(value).getTime()).sort((a, b) => b - a);
  if (scheduled.length < limits.hourly) return { action: "send", at: now };
  // The hourly-th most recent send sets the earliest free slot: one hour after it.
  const blocker = scheduled[limits.hourly - 1]!;
  const at = new Date(Math.max(now.getTime(), blocker + 3_600_000));
  return at.getTime() <= now.getTime() ? { action: "send", at: now } : { action: "later", at };
}
