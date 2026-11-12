-- Coarse due time for scheduled drafts, so the scheduled-send job can find due mail with an index
-- instead of decrypting every mailbox's drafts each minute. The exact time stays encrypted in
-- extras_enc; this column holds only that time rounded down to the hour, or 'infinity' for a draft
-- with no schedule. NULL means not computed yet (rows saved before this migration); the job fills it.
alter table cumulus_mail.messages add column if not exists due_at timestamptz;

create index if not exists messages_drafts_due
  on cumulus_mail.messages (due_at)
  where folder = 'drafts';
