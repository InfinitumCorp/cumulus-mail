-- Second factor, hardened (pre-launch review of #189). All additive.
-- satisfied_sessions: which signed-in sessions passed the factor, and until when (JSON list of
--   {"h": sha256 of the session id, "until": ISO time}). Replaces the one window per mailbox, which
--   opened the mailbox to every session, a stolen one included, once the owner passed on any device.
-- totp_last_step: the last 30-second step accepted, so a code cannot be used twice.
-- failures / failures_since: failed codes and key checks per mailbox, kept in the database so the
--   limit holds across Worker isolates and processes.
alter table cumulus_mail.second_factors add column if not exists satisfied_sessions text not null default '[]';
alter table cumulus_mail.second_factors add column if not exists totp_last_step bigint;
alter table cumulus_mail.second_factors add column if not exists failures integer not null default 0;
alter table cumulus_mail.second_factors add column if not exists failures_since timestamptz;
