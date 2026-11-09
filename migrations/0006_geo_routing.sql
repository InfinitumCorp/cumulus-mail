-- Mailbox geo-routing preference. Default off: existing mailboxes stay off
-- and messages gain no annotation until the preference is turned on.
-- geo_json is ciphertext written by the application. This file has no key material.

alter table cumulus_mail.mailboxes
  add column if not exists geo_routing boolean not null default false;

alter table cumulus_mail.messages
  add column if not exists geo_json text;
