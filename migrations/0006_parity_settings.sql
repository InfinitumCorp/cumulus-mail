-- Mailbox settings, message extras, contact private fields, and password-protected
-- links. Ciphertext is written by the application. This file has no key material.

alter table cumulus_mail.mailboxes add column if not exists settings_enc text;
alter table cumulus_mail.messages add column if not exists extras_enc text;
alter table cumulus_mail.contacts add column if not exists private_enc text;

create table if not exists cumulus_mail.protected_links (
  token_hash text primary key,
  tenant_id text not null,
  envelope_enc text not null,
  expires_at text not null,
  reads_left integer not null,
  self_destruct boolean not null default false
);
