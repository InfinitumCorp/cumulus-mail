import { assertTenantId } from "../storage/adapter.ts";
import { blindIndex } from "./field-crypto.ts";
import type { MailQuery } from "./query.ts";

export async function findTenantByAddress(db: MailQuery, address: string): Promise<string | null> {
  const email = address.trim().toLowerCase();
  if (!email) return null;
  const index = blindIndex(null, "address", email);
  const rows = await db.query<{ tenant_id: string }>(
    `select tenant_id from cumulus_mail.mailboxes where address_bidx = $1
     union
     select tenant_id from cumulus_mail.aliases where address_bidx = $1
     limit 1`,
    [index],
  );
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) return null;
  assertTenantId(tenantId);
  return tenantId;
}

export async function addressOwnedByOther(db: MailQuery, address: string, tenantId: string): Promise<boolean> {
  const email = address.trim().toLowerCase();
  const index = blindIndex(null, "address", email);
  const rows = await db.query<{ tenant_id: string }>(
    `select tenant_id from cumulus_mail.mailboxes where address_bidx = $1 and tenant_id <> $2
     union
     select tenant_id from cumulus_mail.aliases where address_bidx = $1 and tenant_id <> $2
     limit 1`,
    [index, tenantId],
  );
  return rows.length > 0;
}
