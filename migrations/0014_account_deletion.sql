-- Account deletion (src/lib/mail/account-deletion.ts): a request, a 7-day grace period in which it can be
-- cancelled, then a hard delete of every row and blob for the mailbox.
--
-- account_deletions cascades from mailboxes, so the request row itself goes with the mailbox.
create table if not exists cumulus_mail.account_deletions (
  tenant_id text primary key references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  requested_at timestamptz not null,
  purge_after timestamptz not null,
  cancelled_at timestamptz
);

create index if not exists account_deletions_due on cumulus_mail.account_deletions (purge_after)
  where cancelled_at is null;

-- What survives a deletion: that it happened, when, and how much was removed. No content, no address,
-- and not the mailbox id: `subject_hmac` is an HMAC of it under a server key, so the operator can answer
-- "was this account deleted?" when asked about a specific id, but the table alone identifies no one.
-- Deliberately no foreign key: it has to outlive the mailbox.
create table if not exists cumulus_mail.deletion_audit (
  id text primary key,
  subject_hmac text not null,
  requested_at timestamptz not null,
  purged_at timestamptz not null,
  rows_deleted integer not null,
  blobs_deleted integer not null
);

alter table cumulus_mail.account_deletions enable row level security;
alter table cumulus_mail.deletion_audit enable row level security;
revoke all on cumulus_mail.account_deletions from public;
revoke all on cumulus_mail.deletion_audit from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.account_deletions from %I', role_name);
      execute format('revoke all on cumulus_mail.deletion_audit from %I', role_name);
    end if;
  end loop;
end
$rls$;
