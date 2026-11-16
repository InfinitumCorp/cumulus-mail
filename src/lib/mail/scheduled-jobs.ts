import { purgeDueDeletions } from "./account-deletion.ts";
import type { StripeClient } from "./billing.ts";
import type { OutboundConfig } from "./outbound/config.ts";
import { processOutboundQueue, type QueueReport } from "./outbound/queue.ts";
import type { MailQuery } from "./query.ts";
import { releaseScheduledMail, type ReleaseReport } from "./release.ts";

export type ScheduledJobsReport = ReleaseReport & { outbound: QueueReport | null; deletions: { purged: number; failed: number } };

/**
 * One run of the scheduled jobs, given a database and storage:
 *   1. release due scheduled drafts and expired undo holds;
 *   2. send due outbound queue rows, when SMTP is configured;
 *   3. hard-delete mailboxes whose 7-day deletion grace period has ended.
 * Safe to overlap: the queue claims rows atomically, releases skip drafts edited meanwhile, and a purge
 * that runs twice finds nothing the second time.
 */
export async function runScheduledJobsOn(
  db: MailQuery,
  storageFor: Parameters<typeof releaseScheduledMail>[1],
  now: number,
  options: { outbound: OutboundConfig | null; stripe?: StripeClient | null },
): Promise<ScheduledJobsReport> {
  const released = await releaseScheduledMail(db, storageFor, now);
  const queue = options.outbound ? await processOutboundQueue(db, options.outbound, { now: new Date(now) }) : null;
  const deletions = await purgeDueDeletions(db, storageFor, new Date(now), { stripe: options.stripe });
  return { ...released, outbound: queue, deletions };
}
