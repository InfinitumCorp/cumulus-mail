-- Published OpenPGP keys for WKD (RFC 7929). The key is public by definition.
-- local_hash is the z-base32 SHA-1 of the lowercased local part, not the address.
create table if not exists cumulus_mail.wkd_keys (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  domain text not null,
  local_hash text not null,
  public_key text not null,
  primary key (domain, local_hash)
);

create index if not exists wkd_keys_by_hash on cumulus_mail.wkd_keys (local_hash);
create index if not exists wkd_keys_by_tenant on cumulus_mail.wkd_keys (tenant_id);

-- Mailbox second factor. The TOTP secret is sealed with the tenant key.
-- Recovery codes are stored only as SHA-256 hashes. WebAuthn public keys are public.
-- satisfied_until is when this mailbox last passed the factor (12h window).
create table if not exists cumulus_mail.second_factors (
  tenant_id text primary key references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  totp_secret text,
  totp_confirmed boolean not null default false,
  recovery_hashes text not null default '[]',
  credentials text not null default '[]',
  challenges text not null default '[]',
  satisfied_until timestamptz
);

alter table cumulus_mail.wkd_keys enable row level security;
alter table cumulus_mail.second_factors enable row level security;
revoke all on cumulus_mail.wkd_keys from public;
revoke all on cumulus_mail.second_factors from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.wkd_keys from %I', role_name);
      execute format('revoke all on cumulus_mail.second_factors from %I', role_name);
    end if;
  end loop;
end
$rls$;
