import { getSql } from "@/lib/db";
import { createStorageDriver, openTenantStorage } from "@/lib/storage";
import { currentOutbound } from "./outbound/config.ts";
import { processOutboundQueue, type QueueReport } from "./outbound/queue.ts";
import type { MailQuery } from "./query.ts";
import { releaseScheduledMail, type ReleaseReport } from "./release.ts";

/**
 * The scheduled jobs the US copy runs from its Cloudflare cron (workers/email handleScheduled): release
 * due scheduled drafts and expired undo holds, then send due outbound queue rows when SMTP is configured.
 * Safe to overlap: the queue claims rows atomically and releases skip drafts edited meanwhile.
 */
export async function runScheduledJobs(now = Date.now()): Promise<ReleaseReport & { outbound: QueueReport | null }> {
  const sql = await getSql();
  const db: MailQuery = { query: (text, params) => sql.query(text, params ?? []) };
  const driver = createStorageDriver();
  const released = await releaseScheduledMail(db, (tenantId) => openTenantStorage(tenantId, driver), now);
  const outbound = currentOutbound();
  const queue = outbound ? await processOutboundQueue(db, outbound, { now: new Date(now) }) : null;
  return { ...released, outbound: queue };
}
