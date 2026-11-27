/**
 * Outbound safety, on top of the hourly/daily caps (limits.ts):
 *
 * - **Verified accounts only.** Outside mail is held until the mailbox's Cumulus ID email is verified
 *   (`mailboxes.send_verified`, set from the session on sign-in). Mail inside Cumulus is unaffected.
 * - **Warm-up.** A new mailbox starts with low caps that grow over its first week, so a fresh account
 *   cannot be used to blast mail before anyone notices.
 * - **Burst check.** When a mailbox sends many outside recipients in a short time and the message looks
 *   like spam (score ≥ SPAM_THRESHOLD), outside sending is paused for a day with a notice saying why.
 *   Only outside mail is paused; the owner can still read, write and send inside Cumulus.
 *
 * The score is a heuristic, not a filter: it only matters in combination with a burst.
 */
import { assertTenantId } from "../../storage/adapter.ts";
import type { MailMessage } from "../model.ts";
import type { MailQuery } from "../query.ts";
import { metric } from "../../observability/metrics.ts";
import { isCumulus } from "../logic.ts";
import type { SendLimits } from "./limits.ts";

export const SPAM_THRESHOLD = 5;
export const BURST_WINDOW_MS = 10 * 60_000;
export const BURST_RECIPIENTS = 30;
export const PAUSE_MS = 24 * 3_600_000;

/** People outside Cumulus one message may go to (To + Cc, each address once). More is a mailing list. */
export const DEFAULT_MAX_RECIPIENTS = 50;

/**
 * All mailboxes under a week old, together, per hour: off unless MAIL_OUTBOUND_NEW_ACCOUNTS_HOURLY is
 * set. Each new mailbox is already capped (warm-up), but a scripted wave of sign-ups would multiply that
 * cap; this bounds the wave as a whole. Off by default because in launch week every mailbox is under a
 * week old, so a fixed number would hold everyone's mail. Turn it on once most mailboxes are older.
 */
export function newAccountsHourlyFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number.parseInt(env.MAIL_OUTBOUND_NEW_ACCOUNTS_HOURLY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : null;
}

/** Distinct addresses outside Cumulus on a message: what goes out by SMTP. */
export function outsideRecipients(message: Pick<MailMessage, "to" | "cc">): number {
  const seen = new Set<string>();
  for (const person of [...message.to, ...message.cc]) {
    const email = person.email.trim().toLowerCase();
    if (email && !isCumulus(email)) seen.add(email);
  }
  return seen.size;
}

export function maxRecipientsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.MAIL_OUTBOUND_MAX_RECIPIENTS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000) : DEFAULT_MAX_RECIPIENTS;
}

/** Caps for a mailbox `ageDays` old: tight on day 0, the configured limits from day 7. */
export function warmupLimits(base: SendLimits, ageDays: number): SendLimits {
  const steps: Array<[number, SendLimits]> = [
    [1, { hourly: 10, daily: 20 }],
    [3, { hourly: 20, daily: 50 }],
    [7, { hourly: 50, daily: 150 }],
  ];
  for (const [until, cap] of steps) {
    if (ageDays < until) return { hourly: Math.min(base.hourly, cap.hourly), daily: Math.min(base.daily, cap.daily) };
  }
  return base;
}

const PHRASES = [
  /\bverify your (account|identity|password)\b/i,
  /\b(account|mailbox) (suspended|locked|will be closed)\b/i,
  /\bclick (here|below)\b/i,
  /\b(wire|bank) transfer\b/i,
  /\b(bitcoin|crypto|usdt) (wallet|payment|investment)\b/i,
  /\bgift ?cards?\b/i,
  /\b(urgent|immediately|act now|limited time)\b/i,
  /\b(you have won|winner|lottery|prize)\b/i,
  /\bupdate (your )?(payment|billing) (details|information)\b/i,
];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rb\.gy)\//i;

/** 0 (ordinary) and up. Each signal is one point; see SPAM_THRESHOLD. */
export function spamScore(message: Pick<MailMessage, "subject" | "body" | "to" | "cc">): { score: number; signals: string[] } {
  const signals: string[] = [];
  const text = `${message.subject}\n${message.body}`;
  const links = text.match(/https?:\/\/\S+/gi) ?? [];
  if (links.length >= 5) signals.push("many links");
  if (links.some((l) => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/i.test(l))) signals.push("link to a bare IP");
  if (SHORTENERS.test(text)) signals.push("link shortener");
  const letters = message.subject.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  if (letters.length >= 8 && letters === letters.toUpperCase()) signals.push("subject in capitals");
  if (/[!$]{3,}/.test(message.subject)) signals.push("!!! or $$$ in subject");
  const phrases = PHRASES.filter((p) => p.test(text)).length;
  for (let i = 0; i < Math.min(phrases, 3); i += 1) signals.push("pressure or phishing phrase");
  if (message.to.length + message.cc.length > 20) signals.push("many recipients on one message");
  if (message.body.trim().length < 40 && links.length >= 1) signals.push("a link and almost no text");
  return { score: signals.length, signals };
}

export type SafetyDecision = { allowed: true; limits: SendLimits } | { allowed: false; reason: string };

/** Whether this mailbox may send outside mail now, and under which caps. */
export async function outboundSafety(
  db: MailQuery,
  tenantId: string,
  message: Pick<MailMessage, "subject" | "body" | "to" | "cc">,
  base: SendLimits,
  now = new Date(),
  maxRecipients = maxRecipientsFromEnv(),
  newAccountsHourly = newAccountsHourlyFromEnv(),
): Promise<SafetyDecision> {
  assertTenantId(tenantId);
  const recipients = outsideRecipients(message);
  if (recipients > maxRecipients) {
    metric("mail.outbound.held", { reason: "too_many_recipients", recipients });
    return {
      allowed: false,
      // One fixed sentence, so the interface can translate it (the numbers are in the metric).
      reason: "Held in the outbox. This message goes to more people outside Cumulus than one message may. Split it, or use a mailing-list service.",
    };
  }
  const rows = await db.query<{ send_verified: boolean; created_at: string | Date; paused_until: string | Date | null; reason: string | null }>(
    `select m.send_verified, m.created_at, p.paused_until, p.reason
       from cumulus_mail.mailboxes m left join cumulus_mail.outbound_pauses p on p.tenant_id = m.tenant_id
      where m.tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return { allowed: false, reason: "Held in the outbox. This mailbox is not set up for sending." };
  if (!row.send_verified) {
    return { allowed: false, reason: "Held in the outbox. Verify your Cumulus ID email to send outside Cumulus." };
  }
  if (row.paused_until && new Date(row.paused_until).getTime() > now.getTime()) {
    metric("mail.outbound.held", { reason: "paused" });
    return { allowed: false, reason: `Held in the outbox. ${row.reason ?? "Sending outside Cumulus is paused."}` };
  }
  const recent = await db.query<{ n: number | string }>(
    `select count(*) as n from cumulus_mail.outbound_queue where tenant_id = $1 and created_at > $2`,
    [tenantId, new Date(now.getTime() - BURST_WINDOW_MS).toISOString()],
  );
  const { score, signals } = spamScore(message);
  if (Number(recent[0]?.n ?? 0) >= BURST_RECIPIENTS && score >= SPAM_THRESHOLD) {
    const until = new Date(now.getTime() + PAUSE_MS);
    const reason = `Sending outside Cumulus is paused until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC: many messages in a few minutes, and this one looks like spam (${[...new Set(signals)].join(", ")}). If this is a mistake, contact support.`;
    await db.query(
      `insert into cumulus_mail.outbound_pauses (tenant_id, paused_until, reason, created_at) values ($1, $2, $3, $4)
       on conflict (tenant_id) do update set paused_until = excluded.paused_until, reason = excluded.reason, created_at = excluded.created_at`,
      [tenantId, until.toISOString(), reason, now.toISOString()],
    );
    metric("mail.outbound.paused", { by: "auto", hours: PAUSE_MS / 3_600_000, score });
    return { allowed: false, reason: `Held in the outbox. ${reason}` };
  }
  const ageDays = (now.getTime() - new Date(row.created_at).getTime()) / 86_400_000;
  if (newAccountsHourly !== null && ageDays < 7) {
    const wave = await db.query<{ n: number | string }>(
      `select count(*) as n from cumulus_mail.outbound_queue q join cumulus_mail.mailboxes m on m.tenant_id = q.tenant_id
        where q.created_at > $1 and m.created_at > $2`,
      [new Date(now.getTime() - 3_600_000).toISOString(), new Date(now.getTime() - 7 * 86_400_000).toISOString()],
    );
    if (Number(wave[0]?.n ?? 0) >= newAccountsHourly) {
      metric("mail.outbound.held", { reason: "new_accounts_busy" });
      return {
        allowed: false,
        reason: "Held in the outbox. New mailboxes are sending a lot right now, so mail from mailboxes under a week old waits. Try again in an hour.",
      };
    }
  }
  return { allowed: true, limits: warmupLimits(base, ageDays) };
}

/** Record that the mailbox's owner signed in with a verified email. */
export async function markSendVerified(db: MailQuery, tenantId: string): Promise<void> {
  assertTenantId(tenantId);
  await db.query(`update cumulus_mail.mailboxes set send_verified = true where tenant_id = $1 and not send_verified`, [tenantId]);
}

/**
 * The admin kill switch: stop all outside sending for one mailbox, including mail already queued
 * (the queue skips paused mailboxes), until `until`. `resumeSending` lifts it.
 */
export async function pauseSending(db: MailQuery, tenantId: string, until: Date, reason: string, now = new Date()): Promise<void> {
  assertTenantId(tenantId);
  const text = reason.trim().slice(0, 300) || "Sending outside Cumulus is paused by an administrator. Contact support.";
  await db.query(
    `insert into cumulus_mail.outbound_pauses (tenant_id, paused_until, reason, created_at) values ($1, $2, $3, $4)
     on conflict (tenant_id) do update set paused_until = excluded.paused_until, reason = excluded.reason, created_at = excluded.created_at`,
    [tenantId, until.toISOString(), text, now.toISOString()],
  );
  metric("mail.outbound.paused", { by: "admin", hours: Math.round((until.getTime() - now.getTime()) / 3_600_000) });
}

export async function resumeSending(db: MailQuery, tenantId: string): Promise<boolean> {
  assertTenantId(tenantId);
  const rows = await db.query(`delete from cumulus_mail.outbound_pauses where tenant_id = $1 returning tenant_id`, [tenantId]);
  return rows.length > 0;
}
