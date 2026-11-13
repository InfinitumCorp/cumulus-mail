import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { MailboxBackup } from "./backup.ts";
import { rejectCallerTenant, type MailboxSnapshot } from "./snapshot.ts";

function asSnapshot(input: unknown): MailboxSnapshot {
  rejectCallerTenant(input);
  if (!input || typeof input !== "object" || !Array.isArray((input as MailboxSnapshot).messages)) {
    throw new Error("Missing mailbox");
  }
  return input as MailboxSnapshot;
}

function asBackup(input: unknown): MailboxBackup {
  if (!input || typeof input !== "object") throw new Error("Missing backup");
  const record = { ...(input as MailboxBackup & { tenant?: string }) };
  delete record.tenantId;
  delete record.tenant;
  if (record.version !== 1 || !Array.isArray(record.messages) || !Array.isArray(record.blobs)) {
    throw new Error("Unsupported mailbox backup");
  }
  return record;
}

export const getMailbox = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { readMailboxForSession } = await import("./mailbox.server");
    return readMailboxForSession(context.userId, context.bearerToken);
  });

export const putMailbox = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(asSnapshot)
  .handler(async ({ context, data }) => {
    const { writeMailboxForSession } = await import("./mailbox.server");
    return writeMailboxForSession(context.userId, data, context.bearerToken);
  });

export const getAttachment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { messageId?: unknown; attachmentId?: unknown };
    if (typeof value?.messageId !== "string" || typeof value.attachmentId !== "string") {
      throw new Error("Missing attachment");
    }
    return { messageId: value.messageId, attachmentId: value.attachmentId };
  })
  .handler(async ({ context, data }) => {
    const { readAttachmentForSession } = await import("./mailbox.server");
    return readAttachmentForSession(context.userId, data.messageId, data.attachmentId, context.bearerToken);
  });

export const exportMailboxBackup = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { exportMailboxForSession } = await import("./mailbox.server");
    return exportMailboxForSession(context.userId, context.bearerToken);
  });

/** "Report spam" / "Not spam": trains this mailbox's lists and votes on the sender domain's reputation. */
export const reportSpamMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown): { messageId: string; verdict: "spam" | "ham" } => {
    const value = (input ?? {}) as { messageId?: unknown; verdict?: unknown };
    if (typeof value.messageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/.test(value.messageId)) throw new Error("Invalid message id");
    if (value.verdict !== "spam" && value.verdict !== "ham") throw new Error("Unknown verdict");
    return { messageId: value.messageId, verdict: value.verdict };
  })
  .handler(async ({ context, data }) => {
    const { reportSpamForSession } = await import("./mailbox.server");
    return reportSpamForSession(context.userId, data.messageId, data.verdict, context.bearerToken);
  });

export const importMailboxBackup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(asBackup)
  .handler(async ({ context, data }) => {
    const { importMailboxForSession } = await import("./mailbox.server");
    return importMailboxForSession(context.userId, data, context.bearerToken);
  });

export const submitAbuseReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { reporter?: unknown; subjectAddress?: unknown; detail?: unknown };
    if (typeof value?.reporter !== "string" || typeof value.subjectAddress !== "string" || typeof value.detail !== "string") {
      throw new Error("Missing abuse report");
    }
    return { reporter: value.reporter, subjectAddress: value.subjectAddress, detail: value.detail };
  })
  .handler(async ({ context, data }) => {
    const { submitAbuseForSession } = await import("./mailbox.server");
    return submitAbuseForSession(context.userId, data, context.bearerToken);
  });

export const unsubscribeList = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { messageId?: unknown };
    if (typeof value?.messageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/.test(value.messageId)) {
      throw new Error("Missing message");
    }
    return { messageId: value.messageId };
  })
  .handler(async ({ context, data }) => {
    const { unsubscribeForSession } = await import("./mailbox.server");
    return unsubscribeForSession(context.userId, data.messageId, context.bearerToken);
  });

export const createShareLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { messageId?: unknown; attachmentId?: unknown; ttlMs?: unknown };
    if (typeof value?.messageId !== "string" || typeof value.attachmentId !== "string") {
      throw new Error("Missing attachment");
    }
    const ttlMs = typeof value.ttlMs === "number" ? value.ttlMs : 60 * 60 * 1000;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("Share link lifetime is out of range");
    }
    return { messageId: value.messageId, attachmentId: value.attachmentId, ttlMs };
  })
  .handler(async ({ context, data }) => {
    const { issueShareForSession } = await import("./mailbox.server");
    return issueShareForSession(context.userId, data.messageId, data.attachmentId, data.ttlMs, context.bearerToken);
  });

export const openShareLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { token?: unknown };
    if (typeof value?.token !== "string" || !value.token.includes(".")) throw new Error("Missing share token");
    return { token: value.token };
  })
  .handler(async ({ data }) => {
    const { openShareToken } = await import("./mailbox.server");
    return openShareToken(data.token);
  });

export const revokeShareLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { jti?: unknown };
    if (typeof value?.jti !== "string" || !/^[a-f0-9]{32}$/.test(value.jti)) throw new Error("Missing share id");
    return { jti: value.jti };
  })
  .handler(async ({ context, data }) => {
    const { revokeShareForSession } = await import("./mailbox.server");
    return revokeShareForSession(context.userId, data.jti, context.bearerToken);
  });

export const acceptDeliveryStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { raw?: unknown };
    if (typeof value?.raw !== "string" || !value.raw.trim()) throw new Error("Missing delivery status");
    return { raw: value.raw.slice(0, 1_000_000) };
  })
  .handler(async ({ context, data }) => {
    const { acceptDsnForSession } = await import("./mailbox.server");
    return acceptDsnForSession(context.userId, data.raw, context.bearerToken);
  });

export const checkCustomDomain = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { domain?: unknown };
    if (typeof value?.domain !== "string" || !/^[a-z0-9.-]+$/.test(value.domain)) throw new Error("Missing domain");
    return { domain: value.domain };
  })
  .handler(async ({ context, data }) => {
    const { checkDomainForSession } = await import("./mailbox.server");
    return checkDomainForSession(context.userId, data.domain, context.bearerToken);
  });

export const fetchProtectedLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { token?: unknown };
    if (typeof value?.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token)) throw new Error("Missing link");
    return { token: value.token };
  })
  .handler(async ({ data }) => {
    const { readProtectedForToken } = await import("./mailbox.server");
    return readProtectedForToken(data.token);
  });

export const burnProtectedLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    rejectCallerTenant(input);
    const value = input as { token?: unknown };
    if (typeof value?.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token)) throw new Error("Missing link");
    return { token: value.token };
  })
  .handler(async ({ data }) => {
    const { burnProtectedForToken } = await import("./mailbox.server");
    return burnProtectedForToken(data.token);
  });

/** Stripe Checkout for a paid plan, by price lookup key (`plus_monthly`, ...). Returns the URL to open. */
export const startCheckout = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const lookupKey = (input as { lookupKey?: unknown } | null)?.lookupKey;
    if (typeof lookupKey !== "string") throw new Error("Choose a plan");
    return { lookupKey };
  })
  .handler(async ({ context, data }) => {
    const { startCheckoutForSession } = await import("./mailbox.server");
    return startCheckoutForSession(context.userId, data.lookupKey, context.bearerToken);
  });

/** Stripe Customer Portal for this mailbox (change plan, card, cancel, invoices). */
export const openBillingPortal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { openBillingPortalForSession } = await import("./mailbox.server");
    return openBillingPortalForSession(context.userId, context.bearerToken);
  });

/** Whether Stripe is configured, so the account dialog shows billing controls only when they work. */
export const getBillingStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { billingStatusForSession } = await import("./mailbox.server");
    return billingStatusForSession(context.userId, context.bearerToken);
  });
