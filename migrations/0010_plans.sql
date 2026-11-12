-- Plans (docs/plans.md, step 2). Every existing and new mailbox is on 'plus', whose limits equal the
-- limits before plans existed, so this migration changes no behaviour. Billing columns stay empty
-- until billing is built.
alter table cumulus_mail.mailboxes
  add column if not exists plan_id text not null default 'plus',
  add column if not exists plan_status text not null default 'active',
  add column if not exists plan_renews_at timestamptz,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists mailboxes_stripe_customer
  on cumulus_mail.mailboxes (stripe_customer_id)
  where stripe_customer_id is not null;

-- Webhook idempotency, for when billing is built.
create table if not exists cumulus_mail.billing_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

alter table cumulus_mail.billing_events enable row level security;
revoke all on cumulus_mail.billing_events from public;
do $rls$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on cumulus_mail.billing_events from %I', role_name);
    end if;
  end loop;
end
$rls$;
