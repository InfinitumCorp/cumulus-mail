/**
 * Read-only IMAP bridge, phase 1 (docs/imap-bridge.md). Server-side only: app-password tokens scoped
 * read-only, IMAP UID semantics over the app's message ids, and an incremental sync read.
 *
 * **On unless `MAIL_BRIDGE=off`.** The local program is `bridge/cumulus-bridge.mjs` and only binds
 * 127.0.0.1. Writes still need `MAIL_BRIDGE_WRITE=on`.
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

/** Every token can read. */
export const READ_SCOPE = "imap:read";

/**
 * Phase 2: MOVE and APPEND (sent copies). Issued only to a token created with `write: true`, and
 * honoured only while `MAIL_BRIDGE_WRITE=on` as well as `MAIL_BRIDGE=on`. Turning the switch off makes
 * every write token read-only again at once, without revoking anything.
 */
export const WRITE_SCOPE = "imap:write";

/** Largest message APPEND accepts, and the longest an IDLE call waits. */
export const DEFAULT_APPEND_BYTES = 25 * 1024 * 1024;
export const DEFAULT_IDLE_SECONDS = 25;

function positive(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function bridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.MAIL_BRIDGE?.trim().toLowerCase();
  if (value === "off" || value === "false" || value === "0") return false;
  return true;
}

/** Writes need both switches, so the write path stays off on a deployment that only wants reads. */
export function bridgeWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return bridgeEnabled(env) && env.MAIL_BRIDGE_WRITE?.trim().toLowerCase() === "on";
}

export function appendMaxBytes(env: Record<string, string | undefined> = process.env): number {
  return positive(env.MAIL_BRIDGE_APPEND_BYTES, DEFAULT_APPEND_BYTES, 50 * 1024 * 1024);
}

export function idleSeconds(env: Record<string, string | undefined> = process.env): number {
  return positive(env.MAIL_BRIDGE_IDLE_SECONDS, DEFAULT_IDLE_SECONDS, 60);
}

export function bridgeLimits(env: Record<string, string | undefined> = process.env): BridgeLimits {
  return {
    tokens: positive(env.MAIL_BRIDGE_MAX_TOKENS, DEFAULT_LIMITS.tokens, 50),
    perMinute: positive(env.MAIL_BRIDGE_RATE_PER_MINUTE, DEFAULT_LIMITS.perMinute, 6_000),
    pageSize: positive(env.MAIL_BRIDGE_PAGE_SIZE, DEFAULT_LIMITS.pageSize, 1_000),
  };
}
