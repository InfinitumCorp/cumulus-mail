-- A per-message counter of server-side changes (src/lib/mail/mailbox.ts writeSnapshot).
--
-- The server changes messages a tab may already hold: a scheduled send is released (drafts -> sent), a
-- delivery report updates its hops, the IMAP bridge moves one. Each of those adds one to `server_rev`.
-- A tab's save carries the revs it last received; a message whose rev has moved on since keeps the
-- server's version, so an older tab cannot put a sent message back in Drafts or undo a delivery report.
-- Additive: existing rows start at 0, and a save from a client that sends no revs behaves as before.
alter table cumulus_mail.messages add column if not exists server_rev integer not null default 0;
