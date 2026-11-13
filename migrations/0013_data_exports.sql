-- "Download my data" (src/lib/mail/data-export.ts): when each part was last downloaded, so it can be
-- limited to once a day. Holds a timestamp per mailbox and part, nothing else.
create table if not exists cumulus_mail.data_exports (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  part text not null check (part in ('mbox', 'json')),
  last_at timestamptz not null,
  primary key (tenant_id, part)
);

-- Same lock-down as every other mail table (0007): RLS on, no policies.
alter table cumulus_mail.data_exports enable row level security;
revoke all on cumulus_mail.data_exports from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.data_exports from %I', role_name);
    end if;
  end loop;
end
$rls$;
