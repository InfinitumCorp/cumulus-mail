import { assertTenantId } from "../storage/adapter.ts";
import type { SuppressionList } from "./hooks.ts";
import type { MailQuery } from "./query.ts";

export function createSuppressionList(db: MailQuery, tenantId: string): SuppressionList {
  assertTenantId(tenantId);
  return {
    async has(address) {
      const email = address.trim().toLowerCase();
      const rows = await db.query<{ address: string }>(
        `select address from cumulus_mail.suppressions where tenant_id = $1 and lower(address) = $2 limit 1`,
        [tenantId, email],
      );
      return rows.length > 0;
    },
    async add(address, reason) {
      const email = address.trim().toLowerCase();
      if (!email.includes("@")) throw new Error("Suppression needs an email address");
      await db.query(
        `insert into cumulus_mail.suppressions (tenant_id, address, reason) values ($1, $2, $3)
         on conflict (tenant_id, address) do update set reason = excluded.reason`,
        [tenantId, email, reason.slice(0, 500)],
      );
    },
    async list() {
      const rows = await db.query<{ address: string; reason: string }>(
        `select address, reason from cumulus_mail.suppressions where tenant_id = $1 order by address`,
        [tenantId],
      );
      return rows;
    },
  };
}
