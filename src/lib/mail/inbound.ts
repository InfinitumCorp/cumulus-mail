import { annotateMessage, emailDomain, type GeoHookOptions } from "../geo/hook.ts";
import { sha256Hex, type TenantBlobs } from "../storage/index.ts";
import { authenticateInbound, emptyResolver, type DNSResolver } from "./authenticate.ts";
import type { TenantStorage } from "./delivery.ts";
import { findTenantByAddress } from "./directory.ts";
import { createBounceHandler } from "./dsn.ts";
import { applyRules } from "./logic.ts";
import { parseMime } from "./mime.ts";
import type { MailMessage, MailRule } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { insertAttachment, insertMessage } from "./records.ts";

export type InboundEmail = {
  from: string;
  to: string;
  raw: Uint8Array;
};

/** Same documentation address passed to SPF. Geo annotation uses it and does not change that check. */
const INBOUND_CLIENT_IP = "192.0.2.10";

/**
 * Store one inbound message for the local mailbox that owns the envelope
 * recipient. A tenant id in the MIME headers is ignored.
 */
export async function ingestInboundEmail(
  db: MailQuery,
  storageFor: TenantStorage,
  message: InboundEmail,
  resolver: DNSResolver = emptyResolver,
  geo?: GeoHookOptions,
): Promise<{ stored: string[] }> {
  const recipient = message.to.trim().toLowerCase();
  const tenantId = await findTenantByAddress(db, recipient);
  if (!tenantId) return { stored: [] };

  const digest = await sha256Hex(message.raw);
  const id = `in-${digest.slice(0, 32)}`;
  const existing = await db.query<{ id: string }>(
    `select id from cumulus_mail.messages where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, id],
  );
  if (existing.length > 0) return { stored: [id] };

  const parsed = parseMime(message.raw);
  const storage: TenantBlobs = storageFor(tenantId);
  const rawSaved = await storage.put(message.raw);
  const rawKey = rawSaved.blobId;

  const headerType = `${parsed.headers["content-type"] ?? ""} ${parsed.contentType}`;
  if (/multipart\/report|message\/delivery-status/i.test(headerType)) {
    await createBounceHandler(db, tenantId).accept(new TextDecoder().decode(message.raw));
  }

  const attachments = [];
  for (const [index, file] of parsed.attachments.entries()) {
    const attachmentId = `a-${id}-${index}`;
    const saved = await storage.put(file.bytes);
    attachments.push({
      id: attachmentId,
      name: file.name,
      size: file.bytes.byteLength,
      contentType: file.contentType || "application/octet-stream",
      sha256: saved.sha256,
      objectKey: saved.blobId,
    });
  }

  const from = parsed.from.email
    ? parsed.from
    : { name: message.from.split("@")[0] || message.from, email: message.from };
  const auth = await authenticateInbound(
    message.raw,
    { sender: message.from, ip: INBOUND_CLIENT_IP, helo: "inbound.example.test" },
    resolver,
  );
  const draft: MailMessage = {
    id,
    threadId: id,
    folder: auth.disposition === "quarantine" ? "quarantine" : "inbox",
    from,
    to: parsed.to.length
      ? parsed.to
      : [{ name: recipient.split("@")[0] || recipient, email: recipient }],
    cc: parsed.cc,
    subject: parsed.subject || "(no subject)",
    body: parsed.text.slice(0, 1_000_000),
    at: new Date().toISOString(),
    unread: true,
    starred: false,
    labels: [],
    attachments: attachments.map(({ objectKey: _objectKey, ...file }) => file),
    auth,
    headers: parsed.headers,
  };
  const annotated = await annotateMessage(
    draft,
    { ip: INBOUND_CLIENT_IP, domain: emailDomain(from.email) },
    geo,
  );
  const ruleRows = await db.query<{
    id: string;
    from_match: string;
    action: string;
    label: string | null;
  }>(`select id, from_match, action, label from cumulus_mail.rules where tenant_id = $1`, [
    tenantId,
  ]);
  const rules: MailRule[] = ruleRows
    .filter((row) => row.action === "star" || row.action === "archive" || row.action === "label")
    .map((row) => ({
      id: row.id,
      from: row.from_match,
      action: row.action as MailRule["action"],
      label: row.label ?? undefined,
    }));
  await insertMessage(db, tenantId, applyRules(annotated, rules), rawKey);
  for (const file of attachments) await insertAttachment(db, tenantId, id, file);
  return { stored: [id] };
}
