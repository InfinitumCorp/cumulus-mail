-- Read-only IMAP bridge, phase 1 (docs/imap-bridge.md S1-S3). Nothing here is used unless
-- MAIL_BRIDGE=on: the API route 404s and no row is ever written while the flag is off.
--
-- bridge_tokens: one row per app password. Only a SHA-256 hash of the token is stored, so the
-- table cannot be replayed into mailbox access; the token itself is shown once, at creation.
-- scope is fixed to 'imap:read' in phase 1 and checked on every call, so a leaked token cannot
-- write. name is ciphertext written by the application.
create table if not exists cumulus_mail.bridge_tokens (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  name_enc text not null,
  token_sha256 text not null,
  scope text not null default 'imap:read',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  primary key (tenant_id, id)
);

-- A token is looked up by its hash alone (the caller sends no tenant), so this index has to be
-- global and unique: one hash is one token.
create unique index if not exists bridge_tokens_sha256
  on cumulus_mail.bridge_tokens (token_sha256);

-- message_uids: IMAP UID semantics over the app's string message ids. A UID is assigned once per
-- (tenant, folder, message) and never reused, and modseq rises on every change, so a client can ask
-- "what changed since N". A message moved between folders gets a new UID in the new folder, which is
-- what IMAP expects (a move is an APPEND + EXPUNGE).
create table if not exists cumulus_mail.message_uids (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  folder text not null,
  uid bigint not null,
  message_id text not null,
  modseq bigint not null,
  expunged boolean not null default false,
  primary key (tenant_id, folder, uid)
);

create unique index if not exists message_uids_message
  on cumulus_mail.message_uids (tenant_id, folder, message_id);

-- The sync read: "rows in this folder with modseq > N", in modseq order.
create index if not exists message_uids_modseq
  on cumulus_mail.message_uids (tenant_id, folder, modseq);

-- bridge_folders: per folder, the UIDVALIDITY a client caches against, the next UID to hand out and
-- the highest modseq. uidvalidity changes only if UIDs are ever rebuilt, which tells every client to
-- drop its cache for that folder.
create table if not exists cumulus_mail.bridge_folders (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  folder text not null,
  uidvalidity bigint not null,
  uid_next bigint not null default 1,
  modseq bigint not null default 0,
  primary key (tenant_id, folder)
);

-- Same lock-down as every other mail table (0007): RLS on with no policies, so only the table owner
-- (the app's own login) reaches these rows. Tables added after 0007 have to do this themselves.
alter table cumulus_mail.bridge_tokens enable row level security;
alter table cumulus_mail.message_uids enable row level security;
alter table cumulus_mail.bridge_folders enable row level security;
revoke all on cumulus_mail.bridge_tokens from public;
revoke all on cumulus_mail.message_uids from public;
revoke all on cumulus_mail.bridge_folders from public;

do $rls$
declare
  role_name text;
  table_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      foreach table_name in array array['bridge_tokens', 'message_uids', 'bridge_folders']
      loop
        execute format('revoke all on cumulus_mail.%I from %I', table_name, role_name);
      end loop;
    end if;
  end loop;
end
$rls$;
