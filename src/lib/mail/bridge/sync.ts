/**
 * The incremental read a bridge polls (docs/imap-bridge.md S3), and the per-token rate limit.
 *
 * A caller asks for one folder since a modseq and gets back the folder's UIDVALIDITY, the rows that
 * changed (including expunges) and the modseq to ask from next. Everything is read-only: this module
 * contains no write to mail, by construction, so a bridge token cannot change a mailbox.
 */
import type { MailQuery } from "../query.ts";
import { bridgeLimits, type BridgeLimits } from "./config.ts";
import { changesSince, folderState, type UidRow } from "./uids.ts";

export type SyncRequest = { folder: string; sinceModseq?: number; limit?: number };

export type SyncResponse = {
  folder: string;
  uidvalidity: number;
  uidNext: number;
  /** Ask from this modseq next time. Equal to `sinceModseq` when nothing changed. */
  modseq: number;
  /** True when the folder has more changes than this page: call again with the returned modseq. */
  more: boolean;
  changes: UidRow[];
};

/**
 * Changes in one folder. `sinceModseq` of 0 is a full listing (what a client does after a UIDVALIDITY
 * change). A page never splits a modseq: `modseq` is the last row returned, so asking again from it
 * cannot skip a row.
 */
export async function syncFolder(
  db: MailQuery,
  tenantId: string,
  request: SyncRequest,
  options: { limits?: BridgeLimits; env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<SyncResponse> {
  const limits = options.limits ?? bridgeLimits(options.env ?? process.env);
  const since = Math.max(0, Math.floor(request.sinceModseq ?? 0));
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? limits.pageSize)), limits.pageSize);
  const state = await folderState(db, tenantId, request.folder, options.now);
  const changes = await changesSince(db, tenantId, request.folder, since, limit);
  const last = changes.at(-1);
  return {
    folder: request.folder,
    uidvalidity: state.uidvalidity,
    uidNext: state.uidNext,
    modseq: last ? last.modseq : since,
    more: changes.length === limit && (last?.modseq ?? 0) < state.modseq,
    changes,
  };
}

/**
 * Per-token rate limit, in memory. A bridge polls on a timer, so this is about a broken or hostile
 * client hammering one copy, not about billing: each instance keeps its own window, which is enough
 * to stop a loop. A limit that has to hold across instances belongs in the database.
 */
const windows = new Map<string, { until: number; used: number }>();

export type RateDecision = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export function rateCheck(tokenId: string, options: { limits?: BridgeLimits; env?: Record<string, string | undefined>; now?: number } = {}): RateDecision {
  const limits = options.limits ?? bridgeLimits(options.env ?? process.env);
  const now = options.now ?? Date.now();
  const window = windows.get(tokenId);
  if (!window || window.until <= now) {
    windows.set(tokenId, { until: now + 60_000, used: 1 });
    return { allowed: true, remaining: limits.perMinute - 1, retryAfterSeconds: 0 };
  }
  if (window.used >= limits.perMinute) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((window.until - now) / 1000)) };
  }
  window.used += 1;
  return { allowed: true, remaining: limits.perMinute - window.used, retryAfterSeconds: 0 };
}

/** Forget every window. For tests, and for a process that has been idle. */
export function resetRateLimits(): void {
  windows.clear();
}
