import { getSql } from "@/lib/db";
import { DEV_USER_ID, getSessionUser } from "@/lib/auth/verify.server";
import { createStorageDriver, openTenantStorage, TenantAccessError, type StorageDriver } from "@/lib/storage";
import { bytesToBase64 } from "./bytes.ts";
import { importMailbox, exportMailbox, type MailboxBackup } from "./backup.ts";
import { createAbuseIntake } from "./abuse.ts";
import { createBounceHandler } from "./dsn.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import type { MailQuery } from "./query.ts";
import { assertTenantId } from "@/lib/storage/adapter";
import { mailboxAddress } from "./domain.ts";
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

async function sessionMailbox(contextUserId: string): Promise<{ tenantId: string; profile: MailProfile }> {
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

export async function readMailboxForSession(contextUserId: string): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  return openMailbox(await database(), tenantId, profile);
}

export async function writeMailboxForSession(
  contextUserId: string,
  snapshot: MailboxSnapshot,
): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return writeSnapshot(db, storageFor, tenantId, snapshot);
}

export async function readAttachmentForSession(
  contextUserId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string; dataBase64: string }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const file = await readAttachment(db, storageFor(tenantId), tenantId, messageId, attachmentId);
  if (!file) throw new TenantAccessError("Attachment not found");
  return { name: file.name, contentType: file.contentType, dataBase64: bytesToBase64(file.bytes) };
}

export async function exportMailboxForSession(contextUserId: string): Promise<MailboxBackup> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return exportMailbox(db, storageFor(tenantId), tenantId);
}

export async function importMailboxForSession(
  contextUserId: string,
  backup: MailboxBackup,
): Promise<MailboxSnapshot> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return importMailbox(db, storageFor, tenantId, backup);
}

export async function submitAbuseForSession(
  contextUserId: string,
  report: { reporter: string; subjectAddress: string; detail: string },
): Promise<{ id: string; suppressed: true }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  return createAbuseIntake(db, tenantId).submit(report);
}

export async function acceptDsnForSession(
  contextUserId: string,
  raw: string,
): Promise<{ accepted: number }> {
  const { tenantId, profile } = await sessionMailbox(contextUserId);
  const db = await database();
  await openMailbox(db, tenantId, profile);
  const receipts = await createBounceHandler(db, tenantId).accept(raw);
  return { accepted: receipts.length };
}
