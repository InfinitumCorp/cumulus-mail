-- Mailbox preference for cyber geo routing. Off unless the owner turns it on.
alter table cumulus_mail.mailboxes
  add column if not exists geo_routing boolean not null default false;
