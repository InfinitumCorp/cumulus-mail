import { assertTenantId } from "../../storage/adapter.ts";
import { newId } from "../bytes.ts";
import { metric } from "../../observability/metrics.ts";
import { recordBounce } from "../dsn.ts";
import { blindIndex, openText, sealText } from "../field-crypto.ts";
import type { DeliveryHop } from "../model.ts";
import type { MailQuery } from "../query.ts";
import { readMessages, writeDelivery } from "../records.ts";
import type { OutboundConfig } from "./config.ts";
import { signMessage } from "./dkim.ts";
import type { RecipientResult } from "./transport.ts";

export const QUEUED = "Queued for delivery by SMTP.";

/** A row left in 'sending' this long (the sender crashed) is picked up again. */
export const STALE_SENDING_MS = 10 * 60_000;

export type QueuePolicy = {
  /** Attempts before a transient failure becomes a bounce. */
  maxAttempts: number;
  /** First retry delay; doubles each attempt. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Rows per run. */
  limit: number;
};

export const DEFAULT_POLICY: QueuePolicy = {
  maxAttempts: 8,
  baseDelayMs: 60_000,
  maxDelayMs: 6 * 60 * 60_000,
  limit: 50,
};

/** Delay before attempt `attempt + 1`, after `attempt` failures (1-based). */
export function backoffMs(attempt: number, policy: Pick<QueuePolicy, "baseDelayMs" | "maxDelayMs"> = DEFAULT_POLICY): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(exponent, 30));
}

/**
 * The d= to sign with: the key's domain, when the sender is on it or a subdomain of it (relaxed DMARC
 * alignment). Otherwise null: a signature for a domain whose DNS has no matching key fails verification,
 * which receivers treat worse than an unsigned message. Without a configured key domain, the sender's.
 */
export function dkimDomainFor(from: string, keyDomain: string | undefined): string | null {
  const sender = (from.split("@")[1] ?? "").trim().toLowerCase();
  if (!sender) return null;
  if (!keyDomain) return sender;
  const key = keyDomain.trim().toLowerCase();
  return sender === key || sender.endsWith(`.${key}`) ? key : null;
}

export async function enqueueOutbound(
  db: MailQuery,
  tenantId: string,
  item: { messageId: string; from: string; recipient: string; raw: string },
  now = new Date(),
): Promise<void> {
  assertTenantId(tenantId);
  const recipient = item.recipient.trim().toLowerCase();
  await db.query(
    `insert into cumulus_mail.outbound_queue (
       tenant_id, id, message_id, recipient, recipient_bidx, mail_from, raw, next_attempt_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (tenant_id, message_id, recipient_bidx) do nothing`,
    [
      tenantId,
      newId("out"),
      item.messageId,
      sealText(tenantId, recipient),
      blindIndex(tenantId, "outbound", recipient),
      sealText(tenantId, item.from),
      sealText(tenantId, item.raw),
      now.toISOString(),
    ],
  );
}

type Row = {
  tenant_id: string;
  id: string;
  message_id: string;
  recipient: string;
  mail_from: string;
  raw: string;
  attempts: number;
};

export type QueueReport = { sent: number; retried: number; bounced: number };

/** Rows waiting to send, and how long the oldest has waited: the queue-depth metric. */
export async function queueDepth(db: MailQuery, now = new Date()): Promise<{ queued: number; sending: number; oldestQueuedSeconds: number }> {
  const rows = await db.query<{ queued: number | string; sending: number | string; oldest: string | Date | null }>(
    `select count(*) filter (where status = 'queued') as queued,
            count(*) filter (where status = 'sending') as sending,
            min(created_at) filter (where status in ('queued', 'sending')) as oldest
       from cumulus_mail.outbound_queue`,
    [],
  );
  const row = rows[0];
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : now.getTime();
  return { queued: Number(row?.queued ?? 0), sending: Number(row?.sending ?? 0), oldestQueuedSeconds: Math.max(0, Math.round((now.getTime() - oldest) / 1000)) };
}

/**
 * Send due rows. 2xx marks a row sent. 5xx (or running out of attempts)
 * bounces it through `recordBounce`, which suppresses the address on a
 * permanent (5xx) failure only. 4xx and connection errors retry with exponential backoff.
 * The sender's Sent copy gets its delivery line updated each time.
 */
export async function processOutboundQueue(
  db: MailQuery,
  config: OutboundConfig,
  options: { tenantId?: string; now?: Date; policy?: Partial<QueuePolicy> } = {},
): Promise<QueueReport> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const now = options.now ?? new Date();
  const params: unknown[] = [now.toISOString(), policy.limit];
  if (options.tenantId) params.push(options.tenantId);
  // Claim rows atomically (status -> 'sending') so a save and the scheduled job running at the same
  // time cannot both send the same row. A row stuck in 'sending' (a crash mid-send) is reclaimed after
  // STALE_SENDING_MS; that can resend once, which beats losing the message.
  const rows = await db.query<Row>(
    `update cumulus_mail.outbound_queue q
     set status = 'sending', updated_at = $1
     where (q.tenant_id, q.id) in (
       select tenant_id, id from cumulus_mail.outbound_queue
       where ((status = 'queued' and next_attempt_at <= $1)
              or (status = 'sending' and updated_at <= $1::timestamptz - interval '${STALE_SENDING_MS / 1000} seconds'))
         ${options.tenantId ? "and tenant_id = $3" : ""}
       order by next_attempt_at
       limit $2
       for update skip locked
     )
     returning q.tenant_id, q.id, q.message_id, q.recipient, q.mail_from, q.raw, q.attempts`,
    params,
  );
  const report: QueueReport = { sent: 0, retried: 0, bounced: 0 };
  for (const row of rows) {
    const tenantId = row.tenant_id;
    let recipient = "";
    let result: RecipientResult | undefined;
    try {
      recipient = openText(tenantId, row.recipient);
      const from = openText(tenantId, row.mail_from);
      let raw = openText(tenantId, row.raw);
      const signingDomain = config.dkim ? dkimDomainFor(from, config.dkim.domain) : null;
      if (config.dkim && signingDomain) {
        raw = signMessage(raw, { ...config.dkim, domain: signingDomain });
      }
      [result] = await config.transport.send({ from, to: [recipient], raw });
    } catch (error) {
      // One bad row (an unreadable field, a DKIM key that will not load, a transport bug) must not stop
      // the run or leave the other claimed rows stuck. It retries like a 4xx. The detail names the error
      // type only: messages from crypto or the transport are not copied into the database.
      const kind = error instanceof Error ? error.name : "Error";
      result = { recipient, ok: false, permanent: false, status: "4.3.0", detail: `Local error before sending (${kind}).` };
    }
    const attempts = row.attempts + 1;
    if (result?.ok) {
      report.sent += 1;
      metric("mail.outbound.result", { outcome: "sent", attempts });
      await finish(db, row, "sent", attempts, null);
      await updateHop(db, tenantId, row.message_id, recipient, `Sent by SMTP. ${result.detail}`.slice(0, 300));
      continue;
    }
    const failure = result && !result.ok ? result : { permanent: false, status: "4.0.0", detail: "No reply for this recipient" };
    if (failure.permanent || attempts >= policy.maxAttempts) {
      report.bounced += 1;
      metric("mail.outbound.result", { outcome: "bounced", status: failure.status, permanent: failure.permanent, attempts });
      // Out of retries on a 4xx keeps its 4.x.x status: the message bounces, but a
      // server that was down for a while does not get the address suppressed.
      const status = failure.status;
      await finish(db, row, "failed", attempts, failure.detail);
      await recordBounce(db, tenantId, { recipient, action: "failed", status, diagnostic: failure.detail }, row.message_id);
      await updateHop(db, tenantId, row.message_id, recipient, `Bounced (${status}). ${failure.detail}`.slice(0, 300));
      continue;
    }
    report.retried += 1;
    const next = new Date(now.getTime() + backoffMs(attempts, policy));
    metric("mail.outbound.result", { outcome: "retry", status: failure.status, attempts });
    await db.query(
      `update cumulus_mail.outbound_queue
       set status = 'queued', attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, row.id, attempts, next.toISOString(), failure.detail.slice(0, 500)],
    );
    await updateHop(db, tenantId, row.message_id, recipient, `Retrying after ${failure.status}. Next try ${next.toISOString()}.`);
  }
  return report;
}

async function finish(db: MailQuery, row: Row, status: "sent" | "failed", attempts: number, error: string | null): Promise<void> {
  // The sealed body is not needed after the final result.
  await db.query(
    `update cumulus_mail.outbound_queue
     set status = $3, attempts = $4, last_error = $5, raw = '', updated_at = now()
     where tenant_id = $1 and id = $2`,
    [row.tenant_id, row.id, status, attempts, error?.slice(0, 500) ?? null],
  );
}

async function updateHop(db: MailQuery, tenantId: string, messageId: string, email: string, detail: string): Promise<void> {
  const message = (await readMessages(db, tenantId)).find((item) => item.id === messageId);
  if (!message) return;
  const hops: DeliveryHop[] = (message.delivery ?? []).map((hop) =>
    hop.email.toLowerCase() === email ? { ...hop, detail } : hop,
  );
  await writeDelivery(db, tenantId, messageId, hops);
}
