import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { masterKeyFromEnv, tenantKey } from "../storage/crypto.ts";
import type { MailQuery } from "./query.ts";

export type ShareClaims = {
  jti: string;
  tenantId: string;
  blobId: string;
  exp: number;
};

export type ShareLedger = {
  issue(claims: ShareClaims): Promise<void>;
  revoke(jti: string, tenantId: string): Promise<void>;
  status(jti: string): Promise<"active" | "revoked" | "missing">;
};

function shareKey(masterKey: Uint8Array): Buffer {
  return tenantKey(masterKey, "share", "share");
}

function encode(value: ShareClaims): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(masterKey: Uint8Array, payload: string): string {
  return createHmac("sha256", shareKey(masterKey)).update(payload).digest("base64url");
}

export function issueShareToken(
  masterKey: Uint8Array,
  claims: Omit<ShareClaims, "jti"> & { jti?: string },
): { token: string; claims: ShareClaims } {
  const full: ShareClaims = { ...claims, jti: claims.jti ?? randomBytes(16).toString("hex") };
  const payload = encode(full);
  return { token: `${payload}.${sign(masterKey, payload)}`, claims: full };
}

export function readShareToken(masterKey: Uint8Array, token: string, now = Date.now()): ShareClaims {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) throw new Error("Malformed share token");
  const expected = sign(masterKey, payload);
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Share token signature rejected");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as ShareClaims;
  if (!claims.jti || !claims.tenantId || !claims.blobId || typeof claims.exp !== "number") {
    throw new Error("Share token is incomplete");
  }
  if (claims.exp <= now) throw new Error("Share token expired");
  return claims;
}

export async function authorizeShare(
  masterKey: Uint8Array,
  ledger: ShareLedger,
  token: string,
  expected: { tenantId: string; blobId: string },
  now = Date.now(),
): Promise<ShareClaims> {
  const claims = readShareToken(masterKey, token, now);
  if (claims.tenantId !== expected.tenantId || claims.blobId !== expected.blobId) {
    throw new Error("Share token is for a different object");
  }
  const state = await ledger.status(claims.jti);
  if (state !== "active") throw new Error("Share token revoked");
  return claims;
}

export function memoryLedger(): ShareLedger {
  const rows = new Map<string, ShareClaims & { revoked: boolean }>();
  return {
    async issue(claims) {
      rows.set(claims.jti, { ...claims, revoked: false });
    },
    async revoke(jti, tenantId) {
      const row = rows.get(jti);
      if (row && row.tenantId === tenantId) row.revoked = true;
    },
    async status(jti) {
      const row = rows.get(jti);
      if (!row) return "missing";
      return row.revoked ? "revoked" : "active";
    },
  };
}

export function sqlShareLedger(db: MailQuery): ShareLedger {
  return {
    async issue(claims) {
      await db.query(
        `insert into cumulus_mail.share_grants (jti, tenant_id, blob_id, expires_at, revoked)
         values ($1, $2, $3, $4, false)`,
        [claims.jti, claims.tenantId, claims.blobId, new Date(claims.exp).toISOString()],
      );
    },
    async revoke(jti, tenantId) {
      await db.query(
        `update cumulus_mail.share_grants set revoked = true where jti = $1 and tenant_id = $2`,
        [jti, tenantId],
      );
    },
    async status(jti) {
      const rows = await db.query<{ revoked: boolean }>(
        `select revoked from cumulus_mail.share_grants where jti = $1`,
        [jti],
      );
      if (!rows[0]) return "missing";
      return rows[0].revoked === true ? "revoked" : "active";
    },
  };
}

export function shareKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  return masterKeyFromEnv(env);
}

/**
 * Issue a link for a blob this tenant already stored. The token carries the
 * tenant and the blob id. The caller does not choose a different tenant.
 */
export async function issueBlobShare(
  db: MailQuery,
  tenantId: string,
  blobId: string,
  ttlMs: number,
  masterKey: Uint8Array = shareKeyFromEnv(),
): Promise<{ token: string; exp: number }> {
  const rows = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1 and object_key = $2`,
    [tenantId, blobId],
  );
  if (!rows[0]) throw new Error("Blob not found");
  const issued = issueShareToken(masterKey, { tenantId, blobId, exp: Date.now() + ttlMs });
  await sqlShareLedger(db).issue(issued.claims);
  return { token: issued.token, exp: issued.claims.exp };
}

/** Open a link. The tenant comes from the verified token, not from the caller. */
export async function openBlobShare(
  db: MailQuery,
  readBlob: (tenantId: string, blobId: string) => Promise<Uint8Array | null>,
  token: string,
  masterKey: Uint8Array = shareKeyFromEnv(),
): Promise<{ tenantId: string; blobId: string; body: Uint8Array }> {
  const claims = readShareToken(masterKey, token);
  await authorizeShare(masterKey, sqlShareLedger(db), token, { tenantId: claims.tenantId, blobId: claims.blobId });
  const rows = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1 and object_key = $2`,
    [claims.tenantId, claims.blobId],
  );
  if (!rows[0]) throw new Error("Blob not found");
  const body = await readBlob(claims.tenantId, claims.blobId);
  if (!body) throw new Error("Blob not found");
  return { tenantId: claims.tenantId, blobId: claims.blobId, body };
}
