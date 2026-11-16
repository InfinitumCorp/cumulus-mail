/**
 * IMAP IDLE for the bridge (phase 2), as a long poll: the bridge holds one call open and answers its
 * client's IDLE as soon as the folder's modseq moves past what it has.
 *
 * The server keeps nothing per connection. Each call reads the folder's modseq, and if nothing has
 * changed, sleeps and reads again until the deadline. A call that ends without a change returns
 * `changed: false` and the bridge simply calls again; IMAP clients re-issue IDLE well inside the
 * 29 minutes RFC 2177 allows, so a 25 s poll is invisible to them.
 */
import { assertTenantId } from "../../storage/adapter.ts";
import type { MailQuery } from "../query.ts";
import { idleSeconds } from "./config.ts";

export type IdleResult = { folder: string; changed: boolean; modseq: number };

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function currentModseq(db: MailQuery, tenantId: string, folder: string): Promise<number> {
  const rows = await db.query<{ modseq: number | string }>(
    `select modseq from cumulus_mail.bridge_folders where tenant_id = $1 and folder = $2`,
    [tenantId, folder],
  );
  return Number(rows[0]?.modseq ?? 0);
}

export async function waitForChange(
  db: MailQuery,
  tenantId: string,
  folder: string,
  sinceModseq: number,
  options: {
    env?: Record<string, string | undefined>;
    /** Overrides MAIL_BRIDGE_IDLE_SECONDS; capped at the configured value. */
    timeoutSeconds?: number;
    intervalMs?: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
  } = {},
): Promise<IdleResult> {
  assertTenantId(tenantId);
  const cap = idleSeconds(options.env ?? process.env);
  const seconds = Math.min(cap, Math.max(0, options.timeoutSeconds ?? cap));
  const interval = Math.max(50, options.intervalMs ?? 1000);
  const sleep = options.sleep ?? sleepFor;
  const clock = options.clock ?? Date.now;
  const since = Math.max(0, Math.floor(sinceModseq));
  const deadline = clock() + seconds * 1000;
  for (;;) {
    const modseq = await currentModseq(db, tenantId, folder);
    if (modseq > since) return { folder, changed: true, modseq };
    if (options.signal?.aborted || clock() + interval > deadline) return { folder, changed: false, modseq };
    await sleep(interval);
  }
}
