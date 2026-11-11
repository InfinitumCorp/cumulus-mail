import { createHash, randomBytes } from "node:crypto";
import { mailAppHost } from "./domain.ts";
import { sealText, openText } from "./field-crypto.ts";
import type { ProtectedEnvelope } from "./model.ts";
import type { MailQuery } from "./query.ts";

export type ProtectedLinkView = {
  envelope: ProtectedEnvelope;
  readsLeft: number;
  selfDestruct: boolean;
  expiresAt: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseEnvelope(tenantId: string, stored: string): ProtectedEnvelope | null {
  try {
    const parsed = JSON.parse(openText(tenantId, stored)) as ProtectedEnvelope;
    if (!parsed || typeof parsed.ciphertext !== "string" || typeof parsed.expiresAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function issueProtectedLink(
  db: MailQuery,
  tenantId: string,
  envelope: ProtectedEnvelope,
): Promise<{ token: string; href: string }> {
  const token = randomBytes(24).toString("hex");
  await db.query(
    `insert into cumulus_mail.protected_links (
       token_hash, tenant_id, envelope_enc, expires_at, reads_left, self_destruct
     ) values ($1,$2,$3,$4,$5,$6)`,
    [
      hashToken(token),
      tenantId,
      sealText(tenantId, JSON.stringify(envelope)),
      envelope.expiresAt,
      envelope.readsLeft,
      envelope.selfDestruct,
    ],
  );
  return { token, href: `https://${mailAppHost()}/p/${token}` };
}

export async function readProtectedLink(db: MailQuery, token: string, now = Date.now()): Promise<ProtectedLinkView> {
  const rows = await db.query<{
    tenant_id: string;
    envelope_enc: string;
    expires_at: string;
    reads_left: number;
    self_destruct: boolean;
  }>(
    `select tenant_id, envelope_enc, expires_at, reads_left, self_destruct
     from cumulus_mail.protected_links where token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) throw new Error("This link does not exist.");
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now || row.reads_left <= 0) {
    throw new Error("This password-protected message is no longer available.");
  }
  const envelope = parseEnvelope(row.tenant_id, row.envelope_enc);
  if (!envelope || !envelope.ciphertext) throw new Error("This password-protected message is no longer available.");
  return {
    envelope,
    readsLeft: Number(row.reads_left),
    selfDestruct: row.self_destruct === true,
    expiresAt: row.expires_at,
  };
}

export async function burnProtectedLink(db: MailQuery, token: string): Promise<void> {
  const rows = await db.query<{ tenant_id: string; reads_left: number; self_destruct: boolean; envelope_enc: string }>(
    `select tenant_id, reads_left, self_destruct, envelope_enc from cumulus_mail.protected_links where token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return;
  const readsLeft = Math.max(0, Number(row.reads_left) - 1);
  if (row.self_destruct || readsLeft === 0) {
    await db.query(`delete from cumulus_mail.protected_links where token_hash = $1`, [hashToken(token)]);
    return;
  }
  const envelope = parseEnvelope(row.tenant_id, row.envelope_enc);
  if (!envelope) return;
  envelope.readsLeft = readsLeft;
  await db.query(
    `update cumulus_mail.protected_links set reads_left = $2, envelope_enc = $3 where token_hash = $1`,
    [hashToken(token), readsLeft, sealText(row.tenant_id, JSON.stringify(envelope))],
  );
}
