/**
 * Per-mailbox limits on the expensive or abusable session actions (src/lib/mail/mailbox.server.ts).
 * In memory, one window per instance: enough to stop a loop or a script hammering one copy. Sign-in
 * is limited by Better Auth (src/lib/auth/server.ts); sending by the outbound limits
 * (src/lib/mail/outbound/limits.ts).
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(action: string, retryAfterSeconds: number) {
    super(`Too many ${action} requests. Try again in ${retryAfterSeconds} s.`);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Per mailbox: [requests, window in seconds]. */
export const ACTION_LIMITS = {
  export: [10, 3600],
  import: [10, 3600],
  share: [60, 3600],
  domainCheck: [30, 3600],
  abuseReport: [20, 3600],
  unsubscribe: [60, 3600],
} as const satisfies Record<string, readonly [number, number]>;

export type LimitedAction = keyof typeof ACTION_LIMITS;

const windows = new Map<string, { until: number; used: number }>();

/** Count one request; throws RateLimitedError when the mailbox is over the action's limit. */
export function takeAction(tenantId: string, action: LimitedAction, now = Date.now()): void {
  const [limit, seconds] = ACTION_LIMITS[action];
  const key = `${action}\0${tenantId}`;
  const window = windows.get(key);
  if (!window || window.until <= now) {
    windows.set(key, { until: now + seconds * 1000, used: 1 });
    if (windows.size > 50_000) for (const [k, w] of windows) if (w.until <= now) windows.delete(k);
    return;
  }
  if (window.used >= limit) throw new RateLimitedError(action, Math.max(1, Math.ceil((window.until - now) / 1000)));
  window.used += 1;
}

/** For tests. */
export function resetActionLimits(): void {
  windows.clear();
}
