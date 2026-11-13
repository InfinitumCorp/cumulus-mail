-- Inbound spam controls (src/lib/mail/spam.ts).
--
-- sender_reputation: counters per sending DOMAIN, shared by every mailbox, so a domain many people
-- report is caught for everyone. Domains only (they are public, like the MX records they come from);
-- never an address, never content.
create table if not exists cumulus_mail.sender_reputation (
  domain text primary key,
  received bigint not null default 0,
  spam_reports bigint not null default 0,
  ham_reports bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- spam_lists: one mailbox's own "always block" / "never spam" senders, trained by Report spam / Not
-- spam. The address is a blind index under the mailbox's key (like aliases), so the table does not
-- reveal who someone corresponds with.
create table if not exists cumulus_mail.spam_lists (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  address_bidx text not null,
  kind text not null check (kind in ('block', 'allow')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, address_bidx)
);

alter table cumulus_mail.sender_reputation enable row level security;
alter table cumulus_mail.spam_lists enable row level security;
revoke all on cumulus_mail.sender_reputation from public;
revoke all on cumulus_mail.spam_lists from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.sender_reputation from %I', role_name);
      execute format('revoke all on cumulus_mail.spam_lists from %I', role_name);
    end if;
  end loop;
end
$rls$;
