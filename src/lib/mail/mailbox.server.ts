import { getSql } from "@/lib/db";
import { DEV_USER_ID, UnauthorizedError, getSessionUser } from "@/lib/auth/verify.server";
import {
  createLocalJWKSet,
  cumulusIssuer,
  fetchCumulusJwks,
  unverifiedIssuer,
  verifyCumulusToken,
} from "@/lib/auth/cumulus-issuer";
import { createStorageDriver, openTenantStorage, TenantAccessError, type StorageDriver } from "@/lib/storage";
import { bytesToBase64 } from "./bytes.ts";
import { importMailbox, exportMailbox, type MailboxBackup } from "./backup.ts";
import { createAbuseIntake } from "./abuse.ts";
import { createBounceHandler } from "./dsn.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import type { MailQuery } from "./query.ts";
import { assertTenantId } from "@/lib/storage/adapter";
import { mailAppHost, mailboxAddress } from "./domain.ts";
import {
  BILLING_OFF,
  billingStatus,
  type BillingStatus,
  handleStripeEvent,
  openBillingPortal,
  parseStripeEvent,
  startCheckout,
  stripeClient,
  stripeConfig,
  verifyStripeSignature,
} from "./billing.ts";
import { publishAddress } from "./directory.ts";
import { resolverFromEnv } from "./authenticate.ts";
import { refreshDomainVerification } from "./domains.ts";
import { readProtectedLink, burnProtectedLink } from "./protect-store.ts";
import { catchAllAddress } from "./routing.ts";
import { readSettings, writeSettings } from "./records.ts";
import { issueBlobShare, openBlobShare, sqlShareLedger } from "./share.ts";
import type { MailProfile, MailboxSnapshot } from "./snapshot.ts";

const globalDriver = globalThis as typeof globalThis & { __cumulusMailDriver?: StorageDriver };

function driver(): StorageDriver {
  globalDriver.__cumulusMailDriver ??= createStorageDriver();
  return globalDriver.__cumulusMailDriver;
}

function storageFor(tenantId: string) {
  return openTenantStorage(tenantId, driver());
}

async function database(): Promise<MailQuery> {
  const sql = await getSql();
  return {
    query: (text, params) => sql.query(text, params ?? []),
  };
}

async function tenantFromCumulusToken(token: string): Promise<string> {
  const issuer = cumulusIssuer();
  if (unverifiedIssuer(token) !== issuer) return "";
  let jwks;
  try {
    jwks = await fetchCumulusJwks(issuer);
  } catch {
    throw new UnauthorizedError();
  }
  const keys = createLocalJWKSet(jwks as { keys: [] });
  const verified = await verifyCumulusToken(token, { issuer, keys });
  return verified.tenantId;
}

async function sessionMailbox(
  contextUserId: string,
  bearerToken?: string,
): Promise<{ tenantId: string; profile: MailProfile }> {
  if (bearerToken && unverifiedIssuer(bearerToken) === cumulusIssuer()) {
    const tenantId = await tenantFromCumulusToken(bearerToken);
    assertTenantId(tenantId);
    return {
      tenantId,
      profile: {
        name: tenantId,
        email: mailboxAddress(tenantId),
        cid: `cid:${tenantId}`,
        plan: "Free",
        quotaGb: 15,
      },
    };
  }
  const session = await getSessionUser();
  if (session) {
    if (session.id !== contextUserId) throw new TenantAccessError("Session does not match");
    assertTenantId(session.id);
    const email = (session.email ?? "").trim().toLowerCase();
    const address = email.includes("@") ? email : mailboxAddress(session.id);
    const name = address.split("@")[0] || "Cumulus";
    return {
      tenantId: session.id,
      profile: { name, email: address, cid: `cid:${session.id}`, plan: "Free", quotaGb: 15 },
    };
  }
  if (contextUserId !== DEV_USER_ID) throw new TenantAccessError("Tenant is not verified");
  return {
    tenantId: DEV_USER_ID,
    profile: { name: "Alex Reid", email: mailboxAddress("alex"), cid: "cid:alex", plan: "Free", quotaGb: 15 },
  };
}

export async function readMailboxForSession(contextUserId: string, bearerToken?: string): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  return openMailbox(await database(), tenantId, profile);
}

export async function writeMailboxForSession(
  contextUserId: string,
  snapshot: MailboxSnapshot,
  bearerToken?: string,
): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return writeSnapshot(db, storageFor, tenantId, snapshot);
}

export async function readAttachmentForSession(
  contextUserId: string,
  messageId: string,
  attachmentId: string,
  bearerToken?: string,
): Promise<{ name: string; contentType: string; dataBase64: string }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const file = await readAttachment(db, storageFor(tenantId), tenantId, messageId, attachmentId);
  if (!file) throw new TenantAccessError("Attachment not found");
  return { name: file.name, contentType: file.contentType, dataBase64: bytesToBase64(file.bytes) };
}

/** Ranked, paged search over the signed-in mailbox (encrypted word index, search.ts). */
export async function searchMailForSession(
  contextUserId: string,
  input: { query: string; cursor?: string | null; folders?: string[] },
  bearerToken?: string,
): Promise<import("./search.ts").SearchPage> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const { searchMessages } = await import("./search.ts");
  return searchMessages(db, tenantId, input.query, { cursor: input.cursor, folders: input.folders, limit: 25 });
}

export async function exportMailboxForSession(contextUserId: string, bearerToken?: string): Promise<MailboxBackup> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return exportMailbox(db, storageFor(tenantId), tenantId);
}

export async function importMailboxForSession(
  contextUserId: string,
  backup: MailboxBackup,
  bearerToken?: string,
): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return importMailbox(db, storageFor, tenantId, backup);
}

export async function unsubscribeForSession(
  contextUserId: string,
  messageId: string,
  bearerToken?: string,
): Promise<import("./unsubscribe.ts").UnsubscribeResult> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const { unsubscribeMessage } = await import("./unsubscribe.ts");
  return unsubscribeMessage(db, tenantId, messageId);
}

export async function submitAbuseForSession(
  contextUserId: string,
  report: { reporter: string; subjectAddress: string; detail: string },
  bearerToken?: string,
): Promise<{ id: string; suppressed: true }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return createAbuseIntake(db, tenantId).submit(report);
}

export async function issueShareForSession(
  contextUserId: string,
  messageId: string,
  attachmentId: string,
  ttlMs: number,
  bearerToken?: string,
): Promise<{ token: string; exp: number }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const rows = await db.query<{ object_key: string }>(
    `select object_key from cumulus_mail.attachments where tenant_id = $1 and message_id = $2 and id = $3`,
    [tenantId, messageId, attachmentId],
  );
  const blobId = rows[0]?.object_key;
  if (!blobId) throw new TenantAccessError("Attachment not found");
  return issueBlobShare(db, tenantId, blobId, ttlMs);
}

export async function openShareToken(token: string): Promise<{ name: string; contentType: string; dataBase64: string }> {
  const db = await database();
  const opened = await openBlobShare(db, async (tenantId, blobId) => {
    const file = await storageFor(tenantId).get(blobId);
    return file?.body ?? null;
  }, token);
  const rows = await db.query<{ name: string; content_type: string }>(
    `select name, content_type from cumulus_mail.attachments where tenant_id = $1 and object_key = $2`,
    [opened.tenantId, opened.blobId],
  );
  const row = rows[0];
  if (!row) throw new TenantAccessError("Attachment not found");
  return { name: row.name, contentType: row.content_type, dataBase64: bytesToBase64(opened.body) };
}

export async function revokeShareForSession(
  contextUserId: string,
  jti: string,
  bearerToken?: string,
): Promise<{ revoked: true }> {
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  await sqlShareLedger(await database()).revoke(jti, tenantId);
  return { revoked: true };
}

export async function acceptDsnForSession(
  contextUserId: string,
  raw: string,
  bearerToken?: string,
): Promise<{ accepted: number }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const receipts = await createBounceHandler(db, tenantId).accept(raw);
  return { accepted: receipts.length };
}

export async function checkDomainForSession(
  contextUserId: string,
  domain: string,
  bearerToken?: string,
): Promise<{ verified: boolean; txtName: string; txtValue: string }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const settings = await readSettings(db, tenantId);
  const current = settings.domains.find((item) => item.domain === domain);
  if (!current) throw new Error("Add that domain in the account panel first.");
  const checked = await refreshDomainVerification({ ...settings, domains: [current] }, resolverFromEnv());
  const verified = checked.domains[0]?.verified === true;
  await writeSettings(db, tenantId, {
    ...settings,
    domains: settings.domains.map((item) => (item.domain === domain ? { ...item, verified } : item)),
  });
  if (verified && current.catchAll) await publishAddress(db, tenantId, catchAllAddress(domain));
  return { verified, txtName: current.txtName, txtValue: current.txtValue };
}

export async function readProtectedForToken(token: string): Promise<{
  envelope: NonNullable<import("./model.ts").MessageExtra["protection"]>;
  readsLeft: number;
  selfDestruct: boolean;
  expiresAt: string;
}> {
  const view = await readProtectedLink(await database(), token);
  return {
    envelope: view.envelope,
    readsLeft: view.readsLeft,
    selfDestruct: view.selfDestruct,
    expiresAt: view.expiresAt,
  };
}

export async function burnProtectedForToken(token: string): Promise<{ burned: true }> {
  await burnProtectedLink(await database(), token);
  return { burned: true };
}

/** Where Stripe sends people back: `BILLING_RETURN_URL`, else this app's own origin. */
function billingReturnUrl(): string {
  const configured = process.env.BILLING_RETURN_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
  return configured ? `${configured.replace(/\/+$/, "")}/` : `https://${mailAppHost()}/`;
}

function billingStripe() {
  const config = stripeConfig();
  if (!config) throw new Error("Billing is not set up yet.");
  return stripeClient(config.secretKey);
}

export async function startCheckoutForSession(
  contextUserId: string,
  lookupKey: unknown,
  bearerToken?: string,
): Promise<{ url: string }> {
  const stripe = billingStripe();
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  return startCheckout(await database(), stripe, { tenantId, lookupKey, returnUrl: billingReturnUrl() });
}

/** Whether billing is on, and whether this mailbox already pays (then only Manage billing is offered). */
export async function billingStatusForSession(contextUserId: string, bearerToken?: string): Promise<BillingStatus> {
  if (!stripeConfig()) return BILLING_OFF;
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  return billingStatus(await database(), tenantId);
}

export async function openBillingPortalForSession(contextUserId: string, bearerToken?: string): Promise<{ url: string }> {
  const stripe = billingStripe();
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  return openBillingPortal(await database(), stripe, { tenantId, returnUrl: billingReturnUrl() });
}

/** Stripe webhook: verify the signature over the raw body, then apply the event once. */
export async function receiveStripeWebhook(payload: string, signature: string | null): Promise<Response> {
  const config = stripeConfig();
  if (!config?.webhookSecret) return new Response("Billing is not set up", { status: 503 });
  let event;
  try {
    verifyStripeSignature(payload, signature, config.webhookSecret);
    event = parseStripeEvent(payload);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    const outcome = await handleStripeEvent(await database(), event, stripeClient(config.secretKey));
    return Response.json({ received: true, outcome });
  } catch (error) {
    console.error("[billing] webhook failed", event.type, error instanceof Error ? error.message : error);
    // 500 makes Stripe retry; the event id was released.
    return new Response("Webhook processing failed", { status: 500 });
  }
}
