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
    return readMailboxForSession(context.userId);
  });

export const putMailbox = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(asSnapshot)
  .handler(async ({ context, data }) => {
    const { writeMailboxForSession } = await import("./mailbox.server");
    return writeMailboxForSession(context.userId, data);
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
    return readAttachmentForSession(context.userId, data.messageId, data.attachmentId);
  });

export const exportMailboxBackup = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { exportMailboxForSession } = await import("./mailbox.server");
    return exportMailboxForSession(context.userId);
  });

export const importMailboxBackup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(asBackup)
  .handler(async ({ context, data }) => {
    const { importMailboxForSession } = await import("./mailbox.server");
    return importMailboxForSession(context.userId, data);
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
    return submitAbuseForSession(context.userId, data);
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
    return acceptDsnForSession(context.userId, data.raw);
  });
