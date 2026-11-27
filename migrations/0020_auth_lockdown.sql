-- Lock the sign-in tables away from the Supabase Data API.
--
-- 0001_auth.sql creates "user", "session", "account" and "verification" in schema
-- public. On a Supabase project, public is exposed through PostgREST, and the
-- project's default privileges grant anon and authenticated full rights on new
-- tables there. Without this file, anyone holding the public (anon) key could read
-- session tokens and write accounts.
--
-- The app reaches these tables with a direct Postgres connection as the table
-- owner, which row level security does not restrict (no FORCE). So: RLS on with no
-- policies, and no table rights for the Data API roles. Safe to re-run.

do $$
declare
  t text;
begin
  foreach t in array array['user', 'session', 'account', 'verification', '_migrations'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on table public.%I from anon', t);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on table public.%I from authenticated', t);
      end if;
    end if;
  end loop;
end
$$;
