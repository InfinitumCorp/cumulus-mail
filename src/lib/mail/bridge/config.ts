/**
 * Read-only IMAP bridge, phase 1 (docs/imap-bridge.md). Server-side only: app-password tokens scoped
 * read-only, IMAP UID semantics over the app's message ids, and an incremental sync read.
 *
 * **Off unless `MAIL_BRIDGE=on`.** While it is off the API route answers 404, no token can be created
 * or used, and no UID row is written. There is no bridge program yet; this is what one would talk to.
 */
export type BridgeLimits = {
  /** Tokens one mailbox may hold at once (revoked ones do not count). */
  tokens: number;
  /** Sync calls allowed per token per minute. */
  perMinute: number;
  /** Messages one sync call may return. */
  pageSize: number;
};

export const DEFAULT_LIMITS: BridgeLimits = { tokens: 5, perMinute: 60, pageSize: 200 };

/** The one scope phase 1 issues and accepts. A token can only read. */
export const READ_SCOPE = "imap:read";

function positive(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function bridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAIL_BRIDGE?.trim().toLowerCase() === "on";
}

export function bridgeLimits(env: Record<string, string | undefined> = process.env): BridgeLimits {
  return {
    tokens: positive(env.MAIL_BRIDGE_MAX_TOKENS, DEFAULT_LIMITS.tokens, 50),
    perMinute: positive(env.MAIL_BRIDGE_RATE_PER_MINUTE, DEFAULT_LIMITS.perMinute, 6_000),
    pageSize: positive(env.MAIL_BRIDGE_PAGE_SIZE, DEFAULT_LIMITS.pageSize, 1_000),
  };
}
