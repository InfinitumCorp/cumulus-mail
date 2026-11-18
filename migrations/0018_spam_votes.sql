-- One shared-reputation vote per mailbox per sending domain (src/lib/mail/spam.ts).
--
-- Before this, a mailbox's "Report spam" counted once per sender ADDRESS, so one person reporting mail
-- from five addresses at a big domain could put that whole domain in Quarantine for everyone. Now each
-- mailbox has at most one vote per domain ("spam" or "ham"), changing it moves the vote, and only mail
-- that passed DMARC for that domain can cast one (src/lib/mail/spam.ts).
--
-- `voter` is a blind index of the domain under the voting mailbox's own key: rows for the same mailbox
-- under different domains cannot be linked to each other or to the mailbox without that key.
create table if not exists cumulus_mail.spam_votes (
  domain text not null,
  voter text not null,
  kind text not null check (kind in ('spam', 'ham')),
  updated_at timestamptz not null default now(),
  primary key (domain, voter)
);

alter table cumulus_mail.spam_votes enable row level security;
revoke all on cumulus_mail.spam_votes from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.spam_votes from %I', role_name);
    end if;
  end loop;
end
$rls$;
