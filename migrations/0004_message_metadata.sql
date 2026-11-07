-- Message metadata ciphertext is written by the application with the tenant
-- key from MAIL_BLOB_KEY. This file adds the columns and blind indexes.
-- It does not contain key material.

alter table cumulus_mail.messages add column if not exists snippet_enc text;
alter table cumulus_mail.messages add column if not exists headers_enc text;

alter table cumulus_mail.mailboxes add column if not exists address_bidx text;
alter table cumulus_mail.aliases add column if not exists address_bidx text;
alter table cumulus_mail.suppressions add column if not exists address_bidx text;

alter table cumulus_mail.mailboxes drop constraint if exists mailboxes_address_key;
drop index if exists cumulus_mail.aliases_address_lower;

create unique index if not exists mailboxes_address_bidx
  on cumulus_mail.mailboxes (address_bidx);

create unique index if not exists aliases_tenant_address_bidx
  on cumulus_mail.aliases (tenant_id, address_bidx);

create unique index if not exists suppressions_tenant_address_bidx
  on cumulus_mail.suppressions (tenant_id, address_bidx);

create table if not exists cumulus_mail.message_blind (
  tenant_id text not null,
  message_id text not null,
  field text not null,
  bidx text not null,
  primary key (tenant_id, message_id, field, bidx),
  foreign key (tenant_id, message_id) references cumulus_mail.messages (tenant_id, id) on delete cascade
);

create index if not exists message_blind_lookup
  on cumulus_mail.message_blind (tenant_id, field, bidx);
