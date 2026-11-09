-- Display names, signatures, and authentication results are ciphertext written
-- by the application. This file does not contain key material.
--
-- Address routing is two steps, because the address index is an HMAC under
-- the tenant key and the tenant is what the lookup is trying to find:
--   1. address_routes lists candidate tenants for the envelope domain.
--      The domain is the partition. It is already on the envelope.
--   2. For each candidate, the app computes HMAC(tenant blind key, address)
--      and compares it with address_bidx. The local-part is never stored.
-- A global unique index on address_bidx assumed one HMAC for every tenant.
-- That index is removed. Uniqueness of an address is checked with the same
-- two-step comparison.

create table if not exists cumulus_mail.address_routes (
  domain text not null,
  tenant_id text not null,
  address_bidx text not null,
  primary key (domain, tenant_id, address_bidx)
);

create index if not exists address_routes_domain
  on cumulus_mail.address_routes (domain);

drop index if exists cumulus_mail.mailboxes_address_bidx;

create index if not exists mailboxes_tenant_address_bidx
  on cumulus_mail.mailboxes (tenant_id, address_bidx);
