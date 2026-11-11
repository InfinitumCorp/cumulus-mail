-- Server role only. No policies are created for anon or authenticated.
-- Enabling RLS with zero policies denies every role that does not own the
-- table and is not a superuser. The Hyperdrive login is the table owner
-- (the Supabase `postgres` role) and keeps access. FORCE is intentionally
-- off so that owner is not locked out.
-- anon and authenticated are revoked when those roles exist (Supabase).
-- A vanilla Postgres used by tests has neither role; the revoke is skipped.

do $rls$
declare
  rel record;
  role_name text;
begin
  for rel in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'cumulus_mail'
      and c.relkind = 'r'
  loop
    execute format(
      'alter table %I.%I enable row level security',
      'cumulus_mail',
      rel.relname
    );
  end loop;

  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on schema cumulus_mail from %I', role_name);
      execute format('revoke all on all tables in schema cumulus_mail from %I', role_name);
      execute format('revoke all on all sequences in schema cumulus_mail from %I', role_name);
      execute format('revoke all on all functions in schema cumulus_mail from %I', role_name);
      execute format(
        'alter default privileges in schema cumulus_mail revoke all on tables from %I',
        role_name
      );
    end if;
  end loop;
end
$rls$;

revoke all on schema cumulus_mail from public;
revoke all on all tables in schema cumulus_mail from public;
