/**
 * Account events from Cumulus://ID, the way a Google Account and Gmail work together:
 *
 * - `account.created`: the person's mailbox exists (and its address receives mail) the moment the
 *   Cumulus://ID is created, before they ever open Mail.
 * - Security events (a new sign-in, a passkey added or removed, the authenticator app turned on or
 *   off, a linked account, a mail key published, everyone signed out): a short notice lands in the
 *   person's inbox from Cumulus://ID, so a change they didn't make is noticed.
 *
 * Cumulus://ID POSTs `{ cid, type, detail, at }` with `x-cid-signature: sha256=<hex HMAC-SHA256 of
 * the raw body>` (secret `CID_EVENTS_SECRET`, the same value as the issuer's `EVENTS_WEBHOOK_SECRET`).
 * - `account.deleted`: the mailbox's addresses (including aliases) stop receiving mail, so new mail to a
 *   deleted Cumulus://ID bounces. Stored mail is kept; Cumulus://ID never gives the address to anyone else.
 *
 * Notices are idempotent: a retried event stores nothing new. Nothing here creates a mailbox for a
 * security event alone; only `account.created` (or opening Mail) does.
 */
import { assertTenantId } from "../storage/adapter.ts";
import { sha256Hex } from "../storage/index.ts";
import type { MailMessage } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { insertMessage } from "./records.ts";
import { replaceRoutedAddresses } from "./directory.ts";
import { provisionMailbox } from "./seed.ts";

export type CidEvent = {
  cid: string;
  type: string;
  detail: Record<string, string | number | boolean | null>;
  at: string;
};

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, body). */
export async function verifyCidEventSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const given = hexToBytes(header.slice(7));
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= want[i]! ^ given[i]!;
  return diff === 0;
}

export function parseCidEvent(body: string): CidEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.cid !== "string" || !/^cid_[0-9a-f-]{36}$/.test(e.cid)) return null;
  if (typeof e.type !== "string" || !/^[a-z_.]{3,60}$/.test(e.type)) return null;
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return null;
  const detail = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as CidEvent["detail"]) : {};
  return { cid: e.cid, type: e.type, detail, at: new Date(e.at).toISOString() };
}

const ACCOUNT_URL = "https://id.cumuluscloud.app/account";
const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : typeof v === "number" ? String(v) : "");

/** Subject and body for a security notice, or null for events that don't warrant one. */
export function noticeFor(e: CidEvent): { subject: string; body: string } | null {
  const when = new Date(e.at).toUTCString();
  const notYou = `If this wasn't you, open ${ACCOUNT_URL}#devices, sign out the sessions you don't recognise, and remove any passkey you didn't add.`;
  const d = e.detail;
  switch (e.type) {
    case "session.created":
      return {
        subject: "New sign-in to your Cumulus://ID",
        body: `Your Cumulus://ID was used to sign in on ${s(d.device) || "a device"}${s(d.country) ? ` in ${s(d.country)}` : ""} at ${when}, with ${s(d.method) || "a passkey"}.\n\n${notYou}`,
      };
    case "passkey.added":
      return { subject: "A passkey was added to your Cumulus://ID", body: `The passkey “${s(d.label) || "Passkey"}” was added at ${when}. It can now sign in to your account.\n\n${notYou}` };
    case "passkey.removed":
      return { subject: "A passkey was removed from your Cumulus://ID", body: `The passkey “${s(d.label) || "Passkey"}” was removed at ${when}.\n\n${notYou}` };
    case "mfa.enabled":
      return { subject: "Authenticator app turned on", body: `Your Cumulus://ID now asks for an authenticator app code after your passkey (since ${when}).\n\n${notYou}` };
    case "mfa.disabled":
      return { subject: "Authenticator app turned off", body: `Your Cumulus://ID no longer asks for an authenticator app code (since ${when}).\n\n${notYou}` };
    case "identity.linked":
      return { subject: "An account was linked to your Cumulus://ID", body: `A ${s(d.provider) || "sign-in"} account was linked at ${when}. It can now sign in to your Cumulus://ID.\n\n${notYou}` };
    case "identity.unlinked":
      return { subject: "An account was unlinked from your Cumulus://ID", body: `A ${s(d.provider) || "sign-in"} account was unlinked at ${when}.\n\n${notYou}` };
    case "session.revoked_all":
      return { subject: "You were signed out everywhere else", body: `${s(d.count) || "Your other"} sessions were signed out at ${when}${s(d.by) ? ` by your ${s(d.by)}` : ""}.\n\n${notYou}` };
    case "mail_key.published":
      return { subject: "A mail encryption key was published", body: `The OpenPGP key ${s(d.fingerprint)} was published for your address at ${when}. People will encrypt mail to it.\n\n${notYou}` };
    case "mail_key.revoked":
      return { subject: "A mail encryption key was withdrawn", body: `A published OpenPGP key was withdrawn at ${when}.\n\n${notYou}` };
    default:
      return null;
  }
}

function betterAuthId(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let out = "";
  for (const b of bytes) if (b < 248 && out.length < 32) out += A[b % 62];
  return out;
}

/**
 * Mail's tenant for a Cumulus://ID is the Better Auth user its sign-in created (the cid is that
 * user's `account.accountId`), not the cid itself. Look it up; with `create`, make the user and
 * account rows the first sign-in would make, so an event that arrives first (account.created) and
 * the later sign-in land on the same tenant. Later sign-ins find the account by (providerId,
 * accountId), or link by the verified email (Cumulus ID providers are trusted for linking).
 */
export async function tenantForCid(
  db: MailQuery,
  cid: string,
  create?: { email: string; name: string },
): Promise<string | null> {
  const found = await db.query<{ userId: string }>(
    `select "userId" from "account" where "accountId" = $1 and "providerId" like 'cumulus-id%' order by "createdAt" limit 1`,
    [cid],
  );
  if (found[0]) return found[0].userId;
  if (!create) return null;
  const byEmail = await db.query<{ id: string }>(`select "id" from "user" where "email" = $1 limit 1`, [create.email]);
  const userId = byEmail[0]?.id ?? betterAuthId();
  if (!byEmail[0]) {
    await db.query(
      `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") values ($1, $2, $3, true, now(), now())`,
      [userId, create.name.slice(0, 200), create.email],
    );
  }
  await db.query(
    `insert into "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") values ($1, $2, 'cumulus-id', $3, now(), now())`,
    [betterAuthId(), cid, userId],
  );
  return userId;
}

async function mailboxExists(db: MailQuery, tenantId: string): Promise<boolean> {
  return (await db.query<{ tenant_id: string }>(`select tenant_id from cumulus_mail.mailboxes where tenant_id = $1 limit 1`, [tenantId])).length > 0;
}

export type HandleResult = "provisioned" | "unrouted" | "notified" | "duplicate" | "no-mailbox" | "ignored";

/** Apply one verified event to the Mail tenant of that Cumulus://ID (see tenantForCid). */
export async function handleCidEvent(db: MailQuery, e: CidEvent, mailDomain: string): Promise<HandleResult> {
  if (e.type === "account.created") {
    const email = s(e.detail.mailAddress).toLowerCase();
    if (!email.endsWith(`@${mailDomain}`)) return "ignored";
    const name = s(e.detail.username) || email.split("@")[0]!;
    const tenantId = (await tenantForCid(db, e.cid, { email, name }))!;
    assertTenantId(tenantId);
    await provisionMailbox(db, tenantId, { name, email, cid: `cid:${tenantId}`, plan: "Free", quotaGb: 15 });
    return "provisioned";
  }
  const tenantId = await tenantForCid(db, e.cid);
  if (!tenantId) return "no-mailbox";
  assertTenantId(tenantId);
  if (e.type === "account.deleted") {
    if (!(await mailboxExists(db, tenantId))) return "no-mailbox";
    await replaceRoutedAddresses(db, tenantId, []);
    return "unrouted";
  }
  const notice = noticeFor(e);
  if (!notice) return "ignored";
  if (!(await mailboxExists(db, tenantId))) return "no-mailbox";
  const id = `cid-${(await sha256Hex(enc.encode(`${e.cid}|${e.type}|${e.at}|${JSON.stringify(e.detail)}`))).slice(0, 40)}`;
  const seen = await db.query<{ id: string }>(`select id from cumulus_mail.messages where tenant_id = $1 and id = $2 limit 1`, [tenantId, id]);
  if (seen.length) return "duplicate";
  const message: MailMessage = {
    id,
    threadId: id,
    folder: "inbox",
    from: { name: "Cumulus://ID", email: `security@${mailDomain}` },
    to: [],
    cc: [],
    subject: notice.subject,
    body: notice.body,
    at: e.at,
    unread: true,
    starred: false,
    labels: ["Security"],
  };
  await insertMessage(db, tenantId, message, null);
  return "notified";
}
