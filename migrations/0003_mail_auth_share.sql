alter table cumulus_mail.messages add column if not exists auth_json text;

create table if not exists cumulus_mail.share_grants (
  jti text primary key,
  tenant_id text not null,
  blob_id text not null,
  expires_at text not null,
  revoked boolean not null default false
);
