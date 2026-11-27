-- The newest save each open tab has had applied (src/lib/mail/save-seq.ts). A tab numbers its saves; a
-- save numbered at or below what the server already applied for that tab is not written. This is what
-- keeps a full save that was still on the wire from undoing the small save the tab sent as it closed
-- (#206), including removals and settings changes, which carry no per-message rev.
-- Additive. Rows older than a week are pruned as saves come in. Without this table the code saves as
-- before (no ordering check).
create table if not exists cumulus_mail.save_sequences (
  tenant_id text not null references cumulus_mail.mailboxes (tenant_id) on delete cascade,
  tab_id text not null,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, tab_id)
);

alter table cumulus_mail.save_sequences enable row level security;
revoke all on cumulus_mail.save_sequences from public;

do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.save_sequences from %I', role_name);
    end if;
  end loop;
end
$rls$;
-- Undo (nothing that matters is lost; saves go back to no ordering check):
--   drop table if exists cumulus_mail.save_sequences;
--   delete from public._migrations where name = '0024_save_sequences.sql';
