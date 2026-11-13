-- Outbound safety (src/lib/mail/outbound/safety.ts).
-- send_verified: the mailbox's Cumulus ID email is verified. Outside mail is held until it is. Set
--   from the session on sign-in, so existing mailboxes become verified on their owner's next visit.
-- outbound_pauses: a mailbox whose outside sending is paused (a suspicious burst), until when and why.
alter table cumulus_mail.mailboxes add column if not exists send_verified boolean not null default false;

create table if not exists cumulus_mail.outbound_pauses (
  tenant_id text primary key references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  paused_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table cumulus_mail.outbound_pauses enable row level security;
revoke all on cumulus_mail.outbound_pauses from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.outbound_pauses from %I', role_name);
    end if;
  end loop;
end
$rls$;
