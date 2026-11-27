import { AsyncLocalStorage } from "node:async_hooks";
import { getSql } from "@/lib/db";
import { takeAction } from "@/lib/rate-limit";
import { markSendVerified } from "./outbound/safety.ts";
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
import { openMailbox, readAttachment, writeDelta, writeSnapshot } from "./mailbox.ts";
import type { MailboxDelta } from "./delta.ts";
import { withTransaction, type MailQuery } from "./query.ts";
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
import { resolverFromEnv } from "./authenticate.ts";
import { refreshDomainVerification } from "./domains.ts";
import { readProtectedLink, burnProtectedLink } from "./protect-store.ts";
import { publishRoutes, readProfile, readRouteState, readSettings, writeSettings } from "./records.ts";
import { issueBlobShare, openBlobShare, sqlShareLedger } from "./share.ts";
import type { MailProfile, MailboxSnapshot } from "./snapshot.ts";

const globalDriver = globalThis as typeof globalThis & { __cumulusMailDriver?: StorageDriver };

/** Set while the second-factor endpoints run, so a locked mailbox can still unlock. */
const skipFactorCheck = new AsyncLocalStorage<true>();

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
    transaction: sql.transaction?.bind(sql),
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
): Promise<{ tenantId: string; profile: MailProfile; verified: boolean; factorSession: string }> {
  let resolved: { tenantId: string; profile: MailProfile; verified: boolean };
  // Which sign-in the second factor is passed for: the session (cookie sign-in) or the bearer token.
  let sessionRef = "";
  if (bearerToken && unverifiedIssuer(bearerToken) === cumulusIssuer()) {
    const tenantId = await tenantFromCumulusToken(bearerToken);
    assertTenantId(tenantId);
    sessionRef = `bearer:${bearerToken}`;
    resolved = {
      verified: true, // a Cumulus ID token: the identity provider verified the email
      tenantId,
      profile: {
        name: tenantId,
        email: mailboxAddress(tenantId),
        cid: `cid:${tenantId}`,
        plan: "Free",
        quotaGb: 15,
      },
    };
  } else {
    const session = await getSessionUser();
    if (session) {
      if (session.id !== contextUserId) {
        const { metric } = await import("@/lib/observability/metrics");
        metric("auth.failure", { reason: "tenant_mismatch" });
        throw new TenantAccessError("Session does not match");
      }
      assertTenantId(session.id);
      sessionRef = `session:${session.sessionId ?? session.id}`;
      const email = (session.email ?? "").trim().toLowerCase();
      const address = email.includes("@") ? email : mailboxAddress(session.id);
      const name = address.split("@")[0] || "Cumulus";
      resolved = {
        verified: session.emailVerified === true,
        tenantId: session.id,
        profile: { name, email: address, cid: `cid:${session.id}`, plan: "Free", quotaGb: 15 },
      };
    } else if (contextUserId !== DEV_USER_ID) {
      throw new TenantAccessError("Tenant is not verified");
    } else {
      resolved = {
        verified: true, // the local development user (sign-in off), never a deployed copy
        tenantId: DEV_USER_ID,
        profile: { name: "Alex Reid", email: mailboxAddress("alex"), cid: "cid:alex", plan: "Free", quotaGb: 15 },
      };
    }
  }
  const { factorBlocks, factorSessionKey } = await import("./factors.ts");
  const factorSession = await factorSessionKey(sessionRef || `dev:${resolved.tenantId}`);
  if (!skipFactorCheck.getStore()) {
    const { FACTOR_REQUIRED } = await import("../auth/factor-gate.ts");
    if (await factorBlocks(await database(), resolved.tenantId, factorSession)) throw new Error(FACTOR_REQUIRED);
  }
  return { ...resolved, factorSession };
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
  const { tenantId, profile, verified } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  if (verified) await markSendVerified(db, tenantId);
  return writeSnapshot(db, storageFor, tenantId, snapshot);
}

/** The change a closing tab could not finish saving (delta.ts), sent with keepalive. */
export async function writeMailboxDeltaForSession(
  contextUserId: string,
  delta: MailboxDelta,
  bearerToken?: string,
): Promise<{ ok: true }> {
  const { tenantId, profile, verified } = await sessionMailbox(contextUserId, bearerToken);
  takeAction(tenantId, "delta");
  const db = await database();
  await openMailbox(db, tenantId, profile);
  if (verified) await markSendVerified(db, tenantId);
  await writeDelta(db, storageFor, tenantId, delta);
  // The page is gone: nobody reads a snapshot back.
  return { ok: true };
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

/** "Report spam" / "Not spam" for a message in this mailbox. The sender is read from the stored message. */
export async function reportSpamForSession(
  contextUserId: string,
  messageId: string,
  verdict: "spam" | "ham" | "block",
  bearerToken?: string,
): Promise<{ ok: true }> {
  const { blockSender, reportedMessage, reportNotSpam, reportSpam } = await import("./spam.ts");
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  takeAction(tenantId, "spamReport");
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const message = await reportedMessage(db, tenantId, messageId);
  if (!message) throw new Error("That message is not in this mailbox.");
  if (verdict === "spam") await reportSpam(db, tenantId, message.from, message.auth);
  else if (verdict === "block") await blockSender(db, tenantId, message.from);
  else await reportNotSpam(db, tenantId, message.from, message.auth);
  return { ok: true };
}

/** Account deletion: ask (7-day grace period), cancel, or see where it stands. */
export async function accountDeletionForSession(
  contextUserId: string,
  action: "status" | "request" | "cancel",
  bearerToken?: string,
): Promise<{ status: { purgeAfter: string } | null }> {
  const { cancelDeletion, deletionStatus, requestDeletion } = await import("./account-deletion.ts");
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  if (action !== "status") takeAction(tenantId, "deletion");
  const db = await database();
  await openMailbox(db, tenantId, profile);
  if (action === "request") await requestDeletion(db, tenantId);
  if (action === "cancel") await cancelDeletion(db, tenantId);
  const status = await deletionStatus(db, tenantId);
  return { status: status && !status.cancelled ? { purgeAfter: status.purgeAfter } : null };
}

/**
 * "Download my data": a five-minute link to one part of the export, or when it is next available.
 * The session is checked here; the download route only verifies the link's signature.
 */
export async function requestDataExportForSession(
  contextUserId: string,
  part: "mbox" | "json",
  bearerToken?: string,
): Promise<{ url: string } | { retryAt: string }> {
  const { exportToken, nextExportAt } = await import("./data-export.ts");
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const next = await nextExportAt(db, tenantId, part);
  if (next) return { retryAt: next.toISOString() };
  return { url: `/api/account/export/${exportToken(tenantId, part)}` };
}

/** The download itself, for the route: the once-a-day claim, then the streamed file. */
export async function dataExportResponse(token: string): Promise<Response> {
  const { claimExport, dataJsonText, mboxStream, nextExportAt, verifyExportToken } = await import("./data-export.ts");
  const link = verifyExportToken(token);
  if (!link) return new Response("This download link is not valid or has expired.", { status: 403 });
  const db = await database();
  if (!(await claimExport(db, link.tenantId, link.part))) {
    const next = await nextExportAt(db, link.tenantId, link.part);
    const seconds = next ? Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000)) : 3600;
    return new Response("Already downloaded today.", { status: 429, headers: { "retry-after": String(seconds) } });
  }
  const day = new Date().toISOString().slice(0, 10);
  const common = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (link.part === "json") {
    return new Response(await dataJsonText(db, link.tenantId), {
      headers: {
        ...common,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="cumulus-mail-data-${day}.json"`,
      },
    });
  }
  return new Response(await mboxStream(db, storageFor(link.tenantId), link.tenantId), {
    headers: {
      ...common,
      "content-type": "application/mbox",
      "content-disposition": `attachment; filename="cumulus-mail-messages-${day}.mbox"`,
    },
  });
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

/** Calendar subscription feed: status, make or rotate (returns the URL, once), or turn off. */
export async function calendarFeedForSession(
  contextUserId: string,
  action: "status" | "rotate" | "disable",
  bearerToken?: string,
): Promise<{ enabled: boolean; url?: string }> {
  const { disableFeed, feedStatus, rotateFeed } = await import("./calendar-feed.ts");
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  if (action === "rotate") {
    const token = await rotateFeed(db, tenantId);
    return { enabled: true, url: `/api/calendar/${token}.ics` };
  }
  if (action === "disable") await disableFeed(db, tenantId);
  return { enabled: (await feedStatus(db, tenantId)).enabled };
}

/** The feed itself, for the route. 404 for an unknown token, exactly as for no feed. */
export async function calendarFeedResponse(token: string): Promise<Response> {
  const { feedIcs, feedTenant } = await import("./calendar-feed.ts");
  const db = await database();
  const tenantId = await feedTenant(db, token);
  if (!tenantId) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const settings = await readSettings(db, tenantId);
  const profile = await readProfile(db, tenantId);
  return new Response(feedIcs(settings.events ?? [], `${profile?.name ?? "Cumulus"} — Cumulus://Mail`), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="calendar.ics"',
      // Private: a shared cache must never hand one person's calendar to another.
      "cache-control": "private, max-age=300",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function exportMailboxForSession(contextUserId: string, bearerToken?: string): Promise<MailboxBackup> {
  const { tenantId, profile } = await sessionMailbox(contextUserId, bearerToken);
  takeAction(tenantId, "export");
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
  takeAction(tenantId, "import");
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
  takeAction(tenantId, "unsubscribe");
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
  takeAction(tenantId, "abuseReport");
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
  takeAction(tenantId, "share");
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
  takeAction(tenantId, "domainCheck");
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
  // Re-publish this mailbox's routes from what is now verified: a domain that stopped verifying stops routing its
  // aliases and catch-all; one that verifies again routes them again.
  const state = await readRouteState(db, tenantId);
  if (state) await withTransaction(db, async () => publishRoutes(db, tenantId, state));
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

export type FactorRequest =
  | { action: "status" }
  | { action: "totp-begin" }
  | { action: "totp-confirm"; code: string }
  | { action: "totp-verify"; code: string }
  | { action: "totp-disable"; code: string }
  | { action: "webauthn-register-options" }
  | { action: "webauthn-register"; name: string; id: string; clientDataJSON: string; attestationObject: string }
  | { action: "webauthn-assert-options" }
  | { action: "webauthn-assert"; id: string; clientDataJSON: string; authenticatorData: string; signature: string }
  | { action: "webauthn-remove"; id: string };

async function factorOrigin(): Promise<string> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { factorOriginFor } = await import("../auth/webauthn.ts");
  return factorOriginFor(mailAppHost(), getRequest() ?? undefined);
}

export type FactorResult =
  | { totp: boolean; pending: boolean; credentials: Array<{ id: string; name: string }>; satisfied: boolean }
  | { secret: string; otpauth: string }
  | { recoveryCodes: string[] }
  | { ok: true }
  | { challenge: string; rpId: string; userId: string; userName: string }
  | { id: string }
  | { challenge: string; rpId: string; credentialIds: string[] };

/** Authenticator and security keys for this mailbox. Not gated by the factor, so a locked mailbox can still unlock. */
export async function secondFactorForSession(
  contextUserId: string,
  request: FactorRequest,
  bearerToken?: string,
): Promise<FactorResult> {
  return skipFactorCheck.run(true, () => secondFactorUnlocked(contextUserId, request, bearerToken));
}

async function secondFactorUnlocked(
  contextUserId: string,
  request: FactorRequest,
  bearerToken?: string,
): Promise<FactorResult> {
  const { tenantId, profile, factorSession } = await sessionMailbox(contextUserId, bearerToken);
  if (request.action !== "status") takeAction(tenantId, "factor");
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const factors = await import("./factors.ts");
  // A locked session may only check in. Enrolling a factor or removing one needs an unlocked session:
  // otherwise a stolen session could add its own key (which unlocked it) or remove the owner's.
  if (!factors.UNLOCK_ACTIONS.has(request.action) && (await factors.factorBlocks(db, tenantId, factorSession))) {
    const { FACTOR_REQUIRED } = await import("../auth/factor-gate.ts");
    throw new Error(FACTOR_REQUIRED);
  }
  const origin = await factorOrigin();
  const host = mailAppHost();
  switch (request.action) {
    case "status":
      return factors.factorStatus(db, tenantId, factorSession);
    case "totp-begin":
      return factors.beginTotp(db, tenantId, profile.email);
    case "totp-confirm":
      return factors.confirmTotp(db, tenantId, request.code, factorSession);
    case "totp-verify":
      await factors.verifyTotp(db, tenantId, request.code, factorSession);
      return { ok: true as const };
    case "totp-disable":
      await factors.disableTotp(db, tenantId, request.code);
      return { ok: true as const };
    case "webauthn-register-options":
      return factors.beginRegistration(db, tenantId, origin, host, profile.email);
    case "webauthn-register":
      return factors.finishRegistration(db, tenantId, origin, host, request.name, {
        id: request.id,
        clientDataJSON: request.clientDataJSON,
        attestationObject: request.attestationObject,
      }, factorSession);
    case "webauthn-assert-options":
      return factors.beginAssertion(db, tenantId, origin, host);
    case "webauthn-assert":
      await factors.finishAssertion(db, tenantId, origin, host, request, factorSession);
      return { ok: true as const };
    case "webauthn-remove":
      await factors.removeCredential(db, tenantId, request.id);
      return { ok: true as const };
    default:
      throw new Error("Unknown factor action");
  }
}

/** Public keys for these recipients: this server's WKD first, then theirs. Misses are omitted. */
export async function lookupPgpKeysForSession(
  contextUserId: string,
  emails: string[],
  bearerToken?: string,
): Promise<{ keys: Record<string, string> }> {
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  takeAction(tenantId, "pgpLookup");
  const db = await database();
  const { fetchWkdKey, splitAddress, wkdLocalHash } = await import("./pgp-keys.ts");
  const { validEmail } = await import("./logic.ts");
  const keys: Record<string, string> = {};
  await Promise.all(
    emails.slice(0, 10).map(async (email) => {
      const normalized = email.trim().toLowerCase();
      if (!validEmail(normalized)) return;
      const parts = splitAddress(normalized);
      if (parts) {
        const rows = await db.query<{ public_key: string }>(
          `select public_key from cumulus_mail.wkd_keys where domain = $1 and local_hash = $2 limit 1`,
          [parts.domain, await wkdLocalHash(parts.local)],
        );
        if (rows[0]?.public_key) {
          keys[normalized] = rows[0].public_key;
          return;
        }
      }
      const { lookupDirectoryKey } = await import("./id-directory.ts");
      const fromId = await lookupDirectoryKey(normalized);
      if (fromId) {
        keys[normalized] = fromId;
        return;
      }
      const remote = await fetchWkdKey(normalized);
      if (remote) keys[normalized] = remote;
    }),
  );
  return { keys };
}

export async function easySwitchForSession(
  contextUserId: string,
  provider: "google" | "microsoft",
  bearerToken?: string,
): Promise<{ configured: false } | { configured: true; url: string }> {
  const { tenantId } = await sessionMailbox(contextUserId, bearerToken);
  const { authorizeUrl, importConfigured, importState } = await import("./easy-switch.ts");
  if (!importConfigured(provider)) return { configured: false };
  const secret = process.env.MAIL_BLOB_KEY?.trim();
  if (!secret) throw new Error("MAIL_BLOB_KEY is not set");
  return { configured: true, url: authorizeUrl(provider, mailAppHost(), importState(provider, tenantId, secret)) };
}
