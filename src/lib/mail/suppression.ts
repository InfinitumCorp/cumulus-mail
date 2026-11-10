import { assertTenantId } from "../storage/adapter.ts";
import { blindIndex, openText, sealText } from "./field-crypto.ts";
import type { SuppressionList } from "./hooks.ts";
import type { MailQuery } from "./query.ts";

export function createSuppressionList(db: MailQuery, tenantId: string): SuppressionList {
  assertTenantId(tenantId);
  return {
    async has(address) {
      const email = address.trim().toLowerCase();
      const rows = await db.query<{ address: string }>(
        `select address from cumulus_mail.suppressions where tenant_id = $1 and address_bidx = $2 limit 1`,
        [tenantId, blindIndex(tenantId, "address", email)],
      );
      return rows.length > 0;
    },
    async add(address, reason) {
      const email = address.trim().toLowerCase();
      if (!email.includes("@")) throw new Error("Suppression needs an email address");
      await db.query(
        `insert into cumulus_mail.suppressions (tenant_id, address, reason, address_bidx) values ($1, $2, $3, $4)
         on conflict (tenant_id, address_bidx) do update set reason = excluded.reason`,
        [tenantId, sealText(tenantId, email), reason.slice(0, 500), blindIndex(tenantId, "address", email)],
      );
    },
    async list() {
      const rows = await db.query<{ address: string; reason: string }>(
        `select address, reason from cumulus_mail.suppressions where tenant_id = $1`,
        [tenantId],
      );
      return rows
        .map((row) => ({ address: openText(tenantId, row.address), reason: row.reason }))
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    },
  };
}
