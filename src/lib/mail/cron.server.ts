import { getSql } from "@/lib/db";
import { createStorageDriver, openTenantStorage } from "@/lib/storage";
import { currentOutbound } from "./outbound/config.ts";
import type { MailQuery } from "./query.ts";
import { runScheduledJobsOn, type ScheduledJobsReport } from "./scheduled-jobs.ts";

/**
 * The scheduled jobs, for POST /api/cron/tick (the Russia copy's scheduler). The same jobs the US copy
 * runs from its Cloudflare cron (workers/email handleScheduled); see src/lib/mail/scheduled-jobs.ts.
 */
export async function runScheduledJobs(now = Date.now()): Promise<ScheduledJobsReport> {
  const sql = await getSql();
  const db: MailQuery = { query: (text, params) => sql.query(text, params ?? []) };
  const driver = createStorageDriver();
  const { deletionStripe } = await import("./account-deletion.ts");
  return runScheduledJobsOn(db, (tenantId) => openTenantStorage(tenantId, driver), now, {
    outbound: currentOutbound(),
    stripe: await deletionStripe(),
  });
}
