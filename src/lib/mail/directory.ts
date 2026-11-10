import { assertTenantId } from "../storage/adapter.ts";
import { blindIndex } from "./field-crypto.ts";
import type { MailQuery } from "./query.ts";
import { catchAllAddress, stripPlus } from "./routing.ts";

/**
 * Routing an address cannot start from a master-key index: the HMAC key is
 * the tenant key, and the tenant is the answer. Lookup is two steps.
 *
 * 1. `address_routes` is the per-domain routing table. The domain comes from
 *    the envelope (or the address being claimed). It is the partition, not a
 *    secret local-part. Each row stores only the tenant id and that tenant's
 *    HMAC of the full address.
 * 2. For each candidate tenant, recompute HMAC(tenant blind key, address) and
 *    keep the row whose stored HMAC matches. A different tenant's key does
 *    not match, so the local-part is not recoverable from the index.
 */
export function addressDomain(address: string): string {
  return address.trim().toLowerCase().split("@")[1] ?? "";
}

export function addressBlind(tenantId: string, address: string): string {
  return blindIndex(tenantId, "address", address.trim().toLowerCase());
}

export async function publishAddress(db: MailQuery, tenantId: string, address: string): Promise<void> {
  assertTenantId(tenantId);
  const email = address.trim().toLowerCase();
  const domain = addressDomain(email);
  if (!domain) return;
  await db.query(
    `insert into cumulus_mail.address_routes (domain, tenant_id, address_bidx)
     values ($1, $2, $3) on conflict do nothing`,
    [domain, tenantId, addressBlind(tenantId, email)],
  );
}

/** Replace every routed address for one tenant. The mailbox address is included. */
export async function replaceRoutedAddresses(db: MailQuery, tenantId: string, addresses: string[]): Promise<void> {
  assertTenantId(tenantId);
  await db.query(`delete from cumulus_mail.address_routes where tenant_id = $1`, [tenantId]);
  for (const address of addresses) await publishAddress(db, tenantId, address);
}

async function matchRoute(db: MailQuery, email: string): Promise<string | null> {
  const domain = addressDomain(email);
  if (!domain) return null;
  const rows = await db.query<{ tenant_id: string; address_bidx: string }>(
    `select tenant_id, address_bidx from cumulus_mail.address_routes where domain = $1`,
    [domain],
  );
  for (const row of rows) {
    try {
      assertTenantId(row.tenant_id);
    } catch {
      continue;
    }
    if (addressBlind(row.tenant_id, email) === row.address_bidx) return row.tenant_id;
  }
  return null;
}

export async function findTenantByAddress(db: MailQuery, address: string): Promise<string | null> {
  const email = address.trim().toLowerCase();
  if (!email) return null;
  const exact = await matchRoute(db, email);
  if (exact) return exact;
  const base = stripPlus(email);
  if (base !== email) {
    const plus = await matchRoute(db, base);
    if (plus) return plus;
  }
  const domain = addressDomain(email);
  if (!domain) return null;
  return matchRoute(db, catchAllAddress(domain));
}

export async function addressOwnedByOther(db: MailQuery, address: string, tenantId: string): Promise<boolean> {
  const owner = await findTenantByAddress(db, address);
  return owner !== null && owner !== tenantId;
}
