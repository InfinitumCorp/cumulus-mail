-- Row level security for every cumulus_mail table, owner-scoped.
--
-- NOT APPLIED. This file is under migrations/rls/, and neither applier descends
-- into a subdirectory: scripts/migrate.mjs reads migrations/ with readdir, and
-- src/lib/db.ts globs "/migrations/*.sql". Same arrangement as
-- migrations/auth/0001_auth.sql. To apply it, an operator copies it up into
-- migrations/ on a branch and runs the migrator deliberately. Approving the
-- four files in migrations/ does not approve this one.
--
-- What "owner" means here. Every table is partitioned by the mailbox that owns
-- the row: tenant_id on all of them except cumulus_mail.deliveries, which keys
-- by sender_tenant. The application already filters by that column on every
-- query, and the tenant comes from a verified session or a verified token, never
-- from the request body. This file is the second line: a direct connection that
-- is not the service role sees only its own rows, and the PostgREST roles
-- (anon, authenticated) see nothing at all unless the tenant is set.
--
-- The service connection still bypasses this. The app connects to the Supabase
-- pooler as `postgres`, which has BYPASSRLS, so enabling RLS does not change
-- what the Worker can read and cannot lock the mailbox out. Making RLS apply to
-- that connection too would need `alter table ... force row level security`
-- plus `set_config('cumulus_mail.tenant_id', ...)` at the start of every
-- transaction; the app does not do that yet, so forcing is deliberately left
-- out. Adding `force` without the set_config calls would break every read.

create schema if not exists cumulus_mail;

-- The owning mailbox for this connection, or null.
--   1. cumulus_mail.tenant_id  — set with set_config() by a client that scopes
--      itself, which is how a non-superuser connection would use these policies.
--   2. request.jwt.claims      — what Supabase/PostgREST sets from the bearer
--      token. `tenant_id` is the claim Cumulus://ID mints; `sub` is the fallback
--      for a Cognito user pool that mints no tenant claim.
-- Null means no policy matches, so a row is neither readable nor writable.
create or replace function cumulus_mail.current_tenant() returns text
  language sql
  stable
  security invoker
  set search_path = ''
as $$
  select nullif(
    coalesce(
      nullif(current_setting('cumulus_mail.tenant_id', true), ''),
      nullif(
        coalesce(
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'tenant_id',
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ),
        ''
      )
    ),
    ''
  );
$$;

comment on function cumulus_mail.current_tenant() is
  'Owning mailbox for the current connection: cumulus_mail.tenant_id, else the tenant_id or sub claim of request.jwt.claims. Null when unset.';

-- One owner-scoped policy per table. `for all` covers select, insert, update and
-- delete; `using` filters the rows that already exist and `with check` refuses a
-- row written under another tenant, so a tenant cannot move a row out of its own
-- partition.
alter table cumulus_mail.mailboxes enable row level security;
drop policy if exists mailboxes_owner on cumulus_mail.mailboxes;
create policy mailboxes_owner on cumulus_mail.mailboxes
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.aliases enable row level security;
drop policy if exists aliases_owner on cumulus_mail.aliases;
create policy aliases_owner on cumulus_mail.aliases
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.messages enable row level security;
drop policy if exists messages_owner on cumulus_mail.messages;
create policy messages_owner on cumulus_mail.messages
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.attachments enable row level security;
drop policy if exists attachments_owner on cumulus_mail.attachments;
create policy attachments_owner on cumulus_mail.attachments
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.contacts enable row level security;
drop policy if exists contacts_owner on cumulus_mail.contacts;
create policy contacts_owner on cumulus_mail.contacts
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.tasks enable row level security;
drop policy if exists tasks_owner on cumulus_mail.tasks;
create policy tasks_owner on cumulus_mail.tasks
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.rules enable row level security;
drop policy if exists rules_owner on cumulus_mail.rules;
create policy rules_owner on cumulus_mail.rules
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.briefs enable row level security;
drop policy if exists briefs_owner on cumulus_mail.briefs;
create policy briefs_owner on cumulus_mail.briefs
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.suppressions enable row level security;
drop policy if exists suppressions_owner on cumulus_mail.suppressions;
create policy suppressions_owner on cumulus_mail.suppressions
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.abuse_reports enable row level security;
drop policy if exists abuse_reports_owner on cumulus_mail.abuse_reports;
create policy abuse_reports_owner on cumulus_mail.abuse_reports
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.bounces enable row level security;
drop policy if exists bounces_owner on cumulus_mail.bounces;
create policy bounces_owner on cumulus_mail.bounces
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.message_blind enable row level security;
drop policy if exists message_blind_owner on cumulus_mail.message_blind;
create policy message_blind_owner on cumulus_mail.message_blind
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

alter table cumulus_mail.share_grants enable row level security;
drop policy if exists share_grants_owner on cumulus_mail.share_grants;
create policy share_grants_owner on cumulus_mail.share_grants
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());

-- deliveries records "this sender already delivered this message", so the owner
-- is the sender.
alter table cumulus_mail.deliveries enable row level security;
drop policy if exists deliveries_owner on cumulus_mail.deliveries;
create policy deliveries_owner on cumulus_mail.deliveries
  for all
  using (sender_tenant = cumulus_mail.current_tenant())
  with check (sender_tenant = cumulus_mail.current_tenant());

-- address_routes answers "which tenants could own an address in this domain",
-- which inbound mail asks before any tenant is known. That lookup runs on the
-- service connection, which bypasses RLS. The owner policy is still here so a
-- scoped connection can read and maintain its own route, and nothing else.
alter table cumulus_mail.address_routes enable row level security;
drop policy if exists address_routes_owner on cumulus_mail.address_routes;
create policy address_routes_owner on cumulus_mail.address_routes
  for all
  using (tenant_id = cumulus_mail.current_tenant())
  with check (tenant_id = cumulus_mail.current_tenant());
