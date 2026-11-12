-- Outbound SMTP queue. Used only when MAIL_SMTP_HOST (or MAIL_OUTBOUND_DEV)
-- is set; otherwise nothing is written here and external mail stays held.
-- recipient, mail_from and raw are sealed with the tenant meta key.
create table if not exists cumulus_mail.outbound_queue (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  id text not null,
  message_id text not null,
  recipient text not null,
  recipient_bidx text not null,
  mail_from text not null,
  raw text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create unique index if not exists outbound_queue_message_recipient
  on cumulus_mail.outbound_queue (tenant_id, message_id, recipient_bidx);

create index if not exists outbound_queue_due
  on cumulus_mail.outbound_queue (status, next_attempt_at);

-- Same posture as 0007: server role only.
alter table cumulus_mail.outbound_queue enable row level security;
revoke all on cumulus_mail.outbound_queue from public;
do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.outbound_queue from %I', role_name);
    end if;
  end loop;
end
$rls$;
