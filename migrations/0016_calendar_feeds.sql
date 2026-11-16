-- Calendar subscription feed (src/lib/mail/calendar-feed.ts): one secret URL per mailbox.
-- Only the SHA-256 of the token is stored, so this table cannot be turned back into working URLs.
-- Rotating replaces the row; turning the feed off deletes it.
create table if not exists cumulus_mail.calendar_feeds (
  tenant_id text primary key references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  token_sha256 text not null unique,
  created_at timestamptz not null
);

alter table cumulus_mail.calendar_feeds enable row level security;
revoke all on cumulus_mail.calendar_feeds from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.calendar_feeds from %I', role_name);
    end if;
  end loop;
end
$rls$;
