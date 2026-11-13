-- Encrypted word index for server-side search (src/lib/mail/search.ts). One row per message: each array
-- holds per-tenant HMACs of the words in that field, never the words. `all_words` is their union, with a
-- GIN index for "every query word matches" lookups.
create table if not exists cumulus_mail.message_words (
  tenant_id text not null,
  message_id text not null,
  subject text[] not null default '{}',
  sender text[] not null default '{}',
  recipients text[] not null default '{}',
  body text[] not null default '{}',
  all_words text[] not null default '{}',
  primary key (tenant_id, message_id),
  foreign key (tenant_id, message_id) references cumulus_mail.messages (tenant_id, id) on delete cascade
);

create index if not exists message_words_all on cumulus_mail.message_words using gin (all_words);

-- Same posture as 0007: server role only.
alter table cumulus_mail.message_words enable row level security;
revoke all on cumulus_mail.message_words from public;
do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.message_words from %I', role_name);
    end if;
  end loop;
end
$rls$;
