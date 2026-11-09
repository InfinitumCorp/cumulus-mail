import { newId } from "./bytes.ts";
import { sealText } from "./field-crypto.ts";
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
    const address = recipient.split(";").pop()?.trim().toLowerCase() ?? "";
    if (!address.includes("@")) continue;
    found.push({
      recipient: address,
      action,
      status,
      diagnostic: fields["diagnostic-code"] ?? "",
    });
  }
  return found;
}

export function isPermanentFailure(report: DsnRecipient): boolean {
  return report.action === "failed" && report.status.startsWith("5");
}

export function createBounceHandler(db: MailQuery, tenantId: string): BounceHandler {
  assertTenantId(tenantId);
  const suppressions = createSuppressionList(db, tenantId);
  return {
    async accept(rawDsn) {
      const reports = parseDsn(rawDsn);
      const receipts: BounceReceipt[] = [];
      for (const report of reports) {
        const suppressed = isPermanentFailure(report);
        const id = newId("bounce");
        await db.query(
          `insert into cumulus_mail.bounces (
             tenant_id, id, message_id, recipient, action, status, diagnostic
           ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, id, null, sealText(tenantId, report.recipient), report.action, report.status, report.diagnostic.slice(0, 2000)],
        );
        if (suppressed) await suppressions.add(report.recipient, `dsn:${report.status}`);
        receipts.push({ ...report, suppressed });
      }
      return receipts;
    },
  };
}
