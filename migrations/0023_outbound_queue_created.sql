-- The sign-up-wave cap (MAIL_OUTBOUND_NEW_ACCOUNTS_HOURLY, #186) counts outside recipients queued in the
-- last hour by mailboxes under a week old. Without this index that count reads the whole queue, which
-- keeps every row ever sent. Additive; build it before turning the cap on.
create index if not exists outbound_queue_created on cumulus_mail.outbound_queue (created_at);
-- Undo (nothing is lost; the count just reads the whole queue again):
--   drop index if exists cumulus_mail.outbound_queue_created;
--   delete from public._migrations where name = '0023_outbound_queue_created.sql';
