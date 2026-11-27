import { newId } from "./bytes.ts";
import { openText, sealText } from "./field-crypto.ts";
import { metric } from "../observability/metrics.ts";
import type { BounceHandler, BounceReceipt } from "./hooks.ts";
import type { MailQuery } from "./query.ts";
import { createSuppressionList } from "./suppression.ts";
import { assertTenantId } from "../storage/adapter.ts";

export type DsnRecipient = {
  recipient: string;
  action: string;
  status: string;
  diagnostic: string;
};

function unfold(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

function headerMap(block: string): Record<string, string> {
  const map: Record<string, string> = {};
  let name = "";
  for (const line of unfold(block).split("\n")) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match?.[1]) {
      name = match[1].toLowerCase();
      map[name] = (match[2] ?? "").trim();
    } else if (name && line.trim()) {
      map[name] = `${map[name]} ${line.trim()}`.trim();
    }
  }
  return map;
}

/** Parse an RFC 5322 / RFC 3464 delivery-status body. */
export function parseDsn(raw: string): DsnRecipient[] {
  const text = raw.replace(/\r\n/g, "\n");
  const blocks = text.split(/\n\s*\n/);
  const found: DsnRecipient[] = [];
  for (const block of blocks) {
    const fields = headerMap(block);
    const recipient = fields["final-recipient"] || fields["original-recipient"];
    const action = fields.action?.trim().toLowerCase();
    const status = fields.status?.trim();
    if (!recipient || !action || !status) continue;
    const address = (recipient.split(";").pop() ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
    if (!address.includes("@")) continue;
    found.push({
      recipient: address,
      action,
      status,
      diagnostic: fields["diagnostic-code"] ?? "",
    });
  }
  if (found.length) return found;
  // Exim and some others send a plain-text bounce without an RFC 3464 part, naming the addresses that
  // failed permanently in X-Failed-Recipients.
  const failed = /^x-failed-recipients:\s*(.+(?:\n[ \t].+)*)/im.exec(text)?.[1] ?? "";
  for (const part of unfold(failed).split(",")) {
    const address = part.trim().replace(/^<|>$/g, "").toLowerCase();
    if (address.includes("@")) found.push({ recipient: address, action: "failed", status: "5.0.0", diagnostic: "X-Failed-Recipients" });
  }
  return found;
}

/**
 * The Message-IDs a bounce quotes from the original message: real MTAs return its headers (RFC 3462
 * text/rfc822-headers or message/rfc822), with the Message-ID we sent it with (`<id@domain>`,
 * outbound/message.ts). Local parts only, lower-cased.
 */
export function quotedMessageIds(raw: string): string[] {
  const ids = new Set<string>();
  for (const match of raw.matchAll(/^(?:message-id|original-message-id|in-reply-to|references)\s*:\s*(.+)$/gim)) {
    for (const id of match[1]!.matchAll(/<([^>@\s]+)@[^>\s]+>/g)) ids.add(id[1]!);
  }
  return [...ids].slice(0, 20);
}

/**
 * The recipients of the messages this mailbox SENT whose ids the bounce quotes. A bounce is only acted on
 * for one of these: anyone can send a "multipart/report" to a mailbox, and acting on an unverified one
 * would let a stranger suppress any address the person writes to (suppression poisoning).
 */
async function quotedRecipients(db: MailQuery, tenantId: string, raw: string): Promise<Set<string>> {
  const recipients = new Set<string>();
  for (const id of quotedMessageIds(raw)) {
    const rows = await db.query<{ to_json: string; cc_json: string }>(
      `select to_json, cc_json from cumulus_mail.messages where tenant_id = $1 and id = $2 and folder = 'sent'`,
      [tenantId, id],
    );
    for (const row of rows) {
      for (const sealed of [row.to_json, row.cc_json]) {
        try {
          for (const person of JSON.parse(openText(tenantId, sealed)) as Array<{ email?: string }>) {
            if (person?.email) recipients.add(person.email.trim().toLowerCase());
          }
        } catch {
          // an unreadable row proves nothing
        }
      }
    }
  }
  return recipients;
}

export function isPermanentFailure(report: DsnRecipient): boolean {
  return report.action === "failed" && report.status.startsWith("5");
}

/**
 * Store one bounce, and suppress the address when the failure is permanent.
 * Used for incoming DSNs and for SMTP failures from the outbound queue.
 * Returns whether the address was suppressed.
 */
export async function recordBounce(
  db: MailQuery,
  tenantId: string,
  report: DsnRecipient,
  messageId: string | null,
  suppressions = createSuppressionList(db, tenantId),
): Promise<boolean> {
  assertTenantId(tenantId);
  const suppressed = isPermanentFailure(report);
  await db.query(
    `insert into cumulus_mail.bounces (
       tenant_id, id, message_id, recipient, action, status, diagnostic
     ) values ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, newId("bounce"), messageId, sealText(tenantId, report.recipient), report.action, report.status, report.diagnostic.slice(0, 2000)],
  );
  if (suppressed) await suppressions.add(report.recipient, `dsn:${report.status}`);
  return suppressed;
}

export function createBounceHandler(db: MailQuery, tenantId: string): BounceHandler {
  assertTenantId(tenantId);
  const suppressions = createSuppressionList(db, tenantId);
  return {
    async accept(rawDsn) {
      const reports = parseDsn(rawDsn);
      if (!reports.length) return [];
      const sentTo = await quotedRecipients(db, tenantId, rawDsn);
      const receipts: BounceReceipt[] = [];
      for (const report of reports) {
        if (!sentTo.has(report.recipient)) {
          // Not about mail this mailbox sent to that address: ignore (counted, never acted on).
          metric("mail.dsn.unverified", {});
          continue;
        }
        const suppressed = await recordBounce(db, tenantId, report, null, suppressions);
        receipts.push({ ...report, suppressed });
      }
      return receipts;
    },
  };
}
