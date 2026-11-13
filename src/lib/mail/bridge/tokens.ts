/**
 * App passwords for the read-only bridge. The token is random, shown once, and stored only as a
 * SHA-256 hash: the table cannot be replayed into mailbox access. Every token carries the fixed
 * `imap:read` scope, which is checked on use, so a leaked token can never write.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertTenantId } from "../../storage/adapter.ts";
import { sealText, openText } from "../field-crypto.ts";
import type { MailQuery } from "../query.ts";
import { bridgeEnabled, bridgeLimits, READ_SCOPE, type BridgeLimits } from "./config.ts";

export class BridgeOffError extends Error {
  constructor() {
    super("The IMAP bridge is off. Set MAIL_BRIDGE=on to enable it.");
    this.name = "BridgeOffError";
  }
}

export class TooManyTokensError extends Error {
  constructor(limit: number) {
    super(`This mailbox already has ${limit} bridge tokens. Revoke one first.`);
    this.name = "TooManyTokensError";
  }
}

export type BridgeToken = {
  id: string;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** `cmb_` and 32 random bytes in base64url: 256 bits, so guessing is not a path in. */
export function newTokenValue(bytes: () => Buffer = () => randomBytes(32)): string {
  return `cmb_${bytes().toString("base64url")}`;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/** Constant-time compare of two hex digests of the same length. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const row = (r: { id: string; name_enc: string; scope: string; created_at: string | Date; last_used_at: string | Date | null; revoked_at: string | Date | null }, tenantId: string): BridgeToken => ({
  id: r.id,
  name: openText(tenantId, r.name_enc),
  scope: r.scope,
  createdAt: new Date(r.created_at).toISOString(),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
});

export async function listTokens(db: MailQuery, tenantId: string): Promise<BridgeToken[]> {
  assertTenantId(tenantId);
  const rows = await db.query<Parameters<typeof row>[0]>(
    `select id, name_enc, scope, created_at, last_used_at, revoked_at
     from cumulus_mail.bridge_tokens
     where tenant_id = $1 and revoked_at is null
     order by created_at`,
    [tenantId],
  );
  return rows.map((r) => row(r, tenantId));
}

/**
 * Create one. The returned `token` is the only time the value exists outside the caller's hands.
 * Refuses while the bridge is off, and once the mailbox holds `limits.tokens` live tokens.
 */
export async function createToken(
  db: MailQuery,
  tenantId: string,
  name: string,
  options: { limits?: BridgeLimits; env?: Record<string, string | undefined>; value?: string; id?: string; now?: Date } = {},
): Promise<{ token: string; record: BridgeToken }> {
  assertTenantId(tenantId);
  const env = options.env ?? process.env;
  if (!bridgeEnabled(env)) throw new BridgeOffError();
  const limits = options.limits ?? bridgeLimits(env);
  const live = await listTokens(db, tenantId);
  if (live.length >= limits.tokens) throw new TooManyTokensError(limits.tokens);
  const token = options.value ?? newTokenValue();
  const id = options.id ?? createHash("sha256").update(token).digest("hex").slice(0, 24);
  const createdAt = (options.now ?? new Date()).toISOString();
  await db.query(
    `insert into cumulus_mail.bridge_tokens (tenant_id, id, name_enc, token_sha256, scope, created_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [tenantId, id, sealText(tenantId, name.slice(0, 120)), tokenHash(token), READ_SCOPE, createdAt],
  );
  return { token, record: { id, name: name.slice(0, 120), scope: READ_SCOPE, createdAt, lastUsedAt: null, revokedAt: null } };
}

/** Revoke one. Returns false when the id is not this mailbox's, or was already revoked. */
export async function revokeToken(db: MailQuery, tenantId: string, id: string, now = new Date()): Promise<boolean> {
  assertTenantId(tenantId);
  const rows = await db.query<{ id: string }>(
    `update cumulus_mail.bridge_tokens set revoked_at = $3
     where tenant_id = $1 and id = $2 and revoked_at is null
     returning id`,
    [tenantId, id, now.toISOString()],
  );
  return rows.length > 0;
}

export type TokenCheck =
  | { ok: true; tenantId: string; id: string; scope: string }
  | { ok: false; reason: "off" | "malformed" | "unknown" | "revoked" | "scope" };

/**
 * Who a `Authorization: Bearer <token>` belongs to. The lookup is by hash, so the stored value is
 * never compared as a string; the hash it finds is compared again in constant time.
 */
export async function checkToken(
  db: MailQuery,
  authorization: string | null | undefined,
  options: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<TokenCheck> {
  const env = options.env ?? process.env;
  if (!bridgeEnabled(env)) return { ok: false, reason: "off" };
  const match = /^Bearer\s+(cmb_[A-Za-z0-9_-]{16,})$/.exec(authorization?.trim() ?? "");
  if (!match) return { ok: false, reason: "malformed" };
  const hash = tokenHash(match[1]!);
  const rows = await db.query<{ tenant_id: string; id: string; scope: string; token_sha256: string; revoked_at: string | Date | null }>(
    `select tenant_id, id, scope, token_sha256, revoked_at from cumulus_mail.bridge_tokens where token_sha256 = $1`,
    [hash],
  );
  const found = rows[0];
  if (!found || !sameHash(found.token_sha256, hash)) return { ok: false, reason: "unknown" };
  if (found.revoked_at) return { ok: false, reason: "revoked" };
  if (found.scope !== READ_SCOPE) return { ok: false, reason: "scope" };
  await db.query(`update cumulus_mail.bridge_tokens set last_used_at = $2 where token_sha256 = $1`, [
    hash,
    (options.now ?? new Date()).toISOString(),
  ]);
  return { ok: true, tenantId: found.tenant_id, id: found.id, scope: found.scope };
}
