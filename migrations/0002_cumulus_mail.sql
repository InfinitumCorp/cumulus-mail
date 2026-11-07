-- Cumulus://Mail metadata. Blobs stay in the storage adapter.
-- This schema is Mail's own. It is not the Drive `cumulus` schema.

create schema if not exists cumulus_mail;

create table if not exists cumulus_mail.mailboxes (
  tenant_id text primary key,
  address text not null unique,
  display_name text not null,
  cid text not null,
  plan text not null,
  quota_gb integer not null,
  signature text not null default '',
  seeded boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists cumulus_mail.aliases (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  address text not null,
  primary key (tenant_id, address)
);

create unique index if not exists aliases_address_lower
  on cumulus_mail.aliases (lower(address));

create table if not exists cumulus_mail.messages (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  thread_id text not null,
  folder text not null,
  from_name text not null,
  from_email text not null,
  to_json text not null,
  cc_json text not null,
  subject text not null,
  body text not null,
  sent_at text not null,
  unread boolean not null,
  starred boolean not null,
  labels_json text not null,
  snooze_until text,
  delivery_json text,
  raw_key text,
  primary key (tenant_id, id)
);

create index if not exists messages_tenant_folder
  on cumulus_mail.messages (tenant_id, folder);

create table if not exists cumulus_mail.attachments (
  tenant_id text not null,
  id text not null,
  message_id text not null,
  name text not null,
  size integer not null,
  content_type text not null,
  sha256 text not null,
  object_key text not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, message_id) references cumulus_mail.messages (tenant_id, id) on delete cascade
);

create table if not exists cumulus_mail.contacts (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  name text not null,
  email text not null,
  org text not null,
  note text not null,
  primary key (tenant_id, id)
);

create table if not exists cumulus_mail.tasks (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  title text not null,
  detail text not null,
  done boolean not null,
  message_id text,
  primary key (tenant_id, id)
);

create table if not exists cumulus_mail.rules (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  from_match text not null,
  action text not null,
  label text,
  primary key (tenant_id, id)
);

create table if not exists cumulus_mail.briefs (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  brief_key text not null,
  body text not null,
  primary key (tenant_id, brief_key)
);

create table if not exists cumulus_mail.suppressions (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  address text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, address)
);

create table if not exists cumulus_mail.abuse_reports (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  reporter text not null,
  subject_address text not null,
  detail text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table if not exists cumulus_mail.bounces (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  message_id text,
  recipient text not null,
  action text not null,
  status text not null,
  diagnostic text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- Survives a mailbox snapshot replace so a sent message is delivered once.
create table if not exists cumulus_mail.deliveries (
  sender_tenant text not null,
  message_id text not null,
  primary key (sender_tenant, message_id)
);
