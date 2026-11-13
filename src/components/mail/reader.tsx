import { Archive, ChevronLeft, Clock, Forward, ListTodo, Lock, Paperclip, Reply, ReplyAll, Shield, Sparkles, Star, Trash2 } from "lucide-react";
import type { Attachment, CalEvent, CustomFolder, FolderId, MailMessage } from "@/lib/mail/model";
import { ME } from "@/lib/mail/model";
import { formatSize, formatWhen, initials, isE2E } from "@/lib/mail/logic";
import { Composer, type DraftForm } from "./composer";

type Props = {
  message: MailMessage | null;
  thread: MailMessage[];
  brief: string;
  briefError: string;
  briefing: boolean;
  notice: string;
  composer: DraftForm | null;
  composeError: string;
  assisting: boolean;
  onBack: () => void;
  onStar: (id: string) => void;
  onArchive: (id: string) => void;
  onTrash: (id: string) => void;
  onSnooze: () => void;
  onUnread: () => void;
  onMute: () => void;
  onRestore: (id: string) => void;
  onRemove: (id: string) => void;
  /** Custom folders offered by "Move to". The control is hidden when there are none. */
  folders?: CustomFolder[];
  onMoveTo?: (id: string, folder: FolderId) => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onBrief: () => void;
  onTask: () => void;
  onChange: (form: DraftForm) => void;
  onSend: () => void;
  onSave: () => void;
  onCloseComposer: () => void;
  onAssist: () => void;
  knownContact: boolean;
  onSaveContact: () => void;
  meEmail?: string;
  onOpenAttachment?: (file: Attachment, messageId: string) => void;
  openedBody?: string;
  unlockError?: string;
  onUnlock?: (password: string) => void;
  warnings?: string[];
  links?: { href: string; reason?: string }[];
  onOpenLink?: (href: string) => void;
  invite?: CalEvent | null;
  onAcceptInvite?: () => void;
  /** Answer the invite (adds it to the calendar and sends an iTIP REPLY when it has an organizer). */
  onRsvp?: (answer: "accepted" | "tentative" | "declined") => void;
  inviteRsvp?: "accepted" | "tentative" | "declined";
  onReceipt?: (accept: boolean) => void;
  onReport?: () => void;
  /** "Report spam" (moves to Quarantine) or, in Quarantine, "Not spam" (back to the Inbox). */
  onSpam?: (verdict: "spam" | "ham") => void;
};

export function Reader(props: Props) {
  const { message, thread } = props;
  const open = Boolean(message);
  return (
    <section className="reader-pane" data-open={open ? "true" : "false"} aria-label="Message">
      {message ? (
        <Opened {...props} message={message} thread={thread} />
      ) : (
        <div className="flex flex-1 flex-col justify-end px-6 py-10 md:px-12 md:py-14">
          <p className="font-mono text-xs uppercase tracking-wide text-accent">Cumulus://Mail</p>
          <h2 className="mt-4 max-w-xl text-4xl leading-none tracking-tight md:text-6xl">Private by default.</h2>
          <p className="mt-5 max-w-md text-base leading-normal text-muted">
            Every mailbox is encrypted at rest. Mail between Cumulus accounts is end-to-end. Never scanned for ads. Never sold.
          </p>
        </div>
      )}
    </section>
  );
}

function Opened({
  message,
  thread,
  brief,
  briefError,
  briefing,
  notice,
  composer,
  composeError,
  assisting,
  onBack,
  onStar,
  onArchive,
  onTrash,
  onSnooze,
  onUnread,
  onMute,
  onRestore,
  onRemove,
  folders = [],
  onMoveTo,
  onReply,
  onReplyAll,
  onForward,
  onBrief,
  onTask,
  onChange,
  onSend,
  onSave,
  onCloseComposer,
  onAssist,
  knownContact,
  onSaveContact,
  meEmail = ME.email,
  onOpenAttachment,
  openedBody,
  unlockError,
  onUnlock,
  warnings = [],
  links = [],
  onOpenLink,
  invite,
  onAcceptInvite,
  onRsvp,
  inviteRsvp,
  onReceipt,
  onReport,
  onSpam,
}: Props & { message: MailMessage }) {
  const e2e = isE2E(message);
  const inline = composer?.placement === "inline" ? composer : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        <button type="button" className="grid size-11 place-items-center lg:hidden" onClick={onBack} aria-label="Back to list">
          <ChevronLeft className="size-5" />
        </button>
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={onReply}>
          <Reply className="size-4" />
          Reply
        </button>
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={onReplyAll}>
          <ReplyAll className="size-4" />
          Reply all
        </button>
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={onForward}>
          <Forward className="size-4" />
          Forward
        </button>
        <button type="button" className="grid size-11 place-items-center" onClick={() => onStar(message.id)} aria-label={message.starred ? "Remove star" : "Star"}>
          <Star className={`size-4 ${message.starred ? "fill-accent text-accent" : ""}`} />
        </button>
        {message.folder === "trash" ? (
          <>
            <button type="button" className="inline-flex h-11 items-center px-3 text-sm" onClick={() => onRestore(message.id)}>
              Restore
            </button>
            <button type="button" className="inline-flex h-11 items-center px-3 text-sm" onClick={() => onRemove(message.id)}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" className="grid size-11 place-items-center" onClick={() => onArchive(message.id)} aria-label="Archive">
              <Archive className="size-4" />
            </button>
            <button type="button" className="grid size-11 place-items-center" onClick={() => onTrash(message.id)} aria-label="Trash">
              <Trash2 className="size-4" />
            </button>
            <button type="button" className="grid size-11 place-items-center" onClick={onSnooze} aria-label="Snooze until tomorrow morning">
              <Clock className="size-4" />
            </button>
            {onMoveTo && folders.length > 0 && message.folder !== "drafts" && message.folder !== "sent" ? (
              <select
                className="h-11 bg-transparent px-2 text-sm hover:text-accent"
                aria-label="Move to folder"
                value=""
                onChange={(event) => {
                  const target = event.target.value as FolderId;
                  if (target) onMoveTo(message.id, target);
                }}
              >
                <option value="">Move to…</option>
                {message.folder !== "inbox" ? <option value="inbox">Inbox</option> : null}
                {folders
                  .filter((folder) => folder.id !== message.folder)
                  .map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
              </select>
            ) : null}
          </>
        )}
        <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={onUnread}>
          Unread
        </button>
        {message.from.email.toLowerCase() !== meEmail.toLowerCase() ? (
          <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={onMute}>
            Mute
          </button>
        ) : null}
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={onTask}>
          <ListTodo className="size-4" />
          Architect
        </button>
        {onSpam && message.from.email.toLowerCase() !== meEmail.toLowerCase() ? (
          message.folder === "quarantine" ? (
            <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={() => onSpam("ham")}>
              Not spam
            </button>
          ) : (
            <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={() => onSpam("spam")}>
              Report spam
            </button>
          )
        ) : null}
        {onReport ? (
          <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={onReport}>
            Report
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6 md:px-8">
          <p className="font-mono text-xs uppercase tracking-wide text-muted">{message.labels.join(" · ") || "Mail"}</p>
          <h2 translate="no" className="mt-3 text-3xl leading-tight tracking-tight md:text-4xl">{message.subject}</h2>
          <p className={`mt-4 inline-flex items-center gap-2 text-sm ${e2e ? "text-accent" : "text-muted"}`}>
            {e2e ? <Lock className="size-4" /> : <Shield className="size-4" />}
            {e2e ? "End-to-end · Cumulus to Cumulus" : "Encrypted at rest · leaves Cumulus when it is delivered"}
          </p>
          {warnings.map((warning) => (
            <p key={warning} className="mt-2 text-sm text-accent">
              {warning}
            </p>
          ))}
          {message.extra?.protection && onUnlock ? (
            <form
              className="mt-4 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                onUnlock(String(data.get("password") ?? ""));
              }}
            >
              <input name="password" type="password" aria-label="Unlock password" className="h-11 w-48 border border-line bg-transparent px-3 text-sm outline-none" />
              <button type="submit" className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink">
                Unlock
              </button>
              {unlockError ? <span className="text-sm">{unlockError}</span> : null}
            </form>
          ) : null}
          {message.extra?.readReceipt === "requested" && message.from.email.toLowerCase() !== meEmail.toLowerCase() && onReceipt ? (
            <div className="mt-3 flex gap-3 text-sm">
              <button type="button" className="text-accent" onClick={() => onReceipt(true)}>
                Send read receipt
              </button>
              <button type="button" className="text-muted" onClick={() => onReceipt(false)}>
                Ignore
              </button>
            </div>
          ) : null}
          {invite && onAcceptInvite ? (
            <div className="mt-4 border-t border-line pt-4">
              <p className="font-mono text-xs uppercase tracking-wide text-accent">Invite</p>
              <p className="mt-2 text-lg tracking-tight">{invite.title}</p>
              <p className="mt-1 text-sm text-muted">{invite.whenLabel}</p>
              {onRsvp ? (
                <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Answer this invite">
                  {(["accepted", "tentative", "declined"] as const).map((answer) => (
                    <button
                      key={answer}
                      type="button"
                      aria-pressed={inviteRsvp === answer}
                      className={`inline-flex h-11 items-center border px-3 text-sm ${inviteRsvp === answer ? "border-accent text-accent" : "border-line hover:border-ink"}`}
                      onClick={() => onRsvp(answer)}
                    >
                      {answer === "accepted" ? "Accept" : answer === "tentative" ? "Maybe" : "Decline"}
                    </button>
                  ))}
                  {!invite.organizer ? <span className="text-xs text-muted">No organizer to answer. It is saved here only.</span> : null}
                </div>
              ) : (
                <button type="button" className="mt-3 inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink" onClick={onAcceptInvite}>
                  Add to calendar
                </button>
              )}
            </div>
          ) : null}
          {message.delivery?.length ? (
            <ul className="mt-3 space-y-1">
              {message.delivery.map((hop) => (
                <li key={hop.email} className="font-mono text-xs text-muted">
                  {hop.email} · {hop.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {brief ? (
            <div className="mt-6 border-t border-line pt-4">
              <p className="font-mono text-xs uppercase tracking-wide text-accent">SCALVS brief</p>
              <p translate="no" className="mt-2 whitespace-pre-wrap text-sm leading-normal">{brief}</p>
            </div>
          ) : null}
          {briefError ? <p className="mt-3 text-sm">{briefError}</p> : null}
          <button
            type="button"
            className="mt-4 inline-flex h-11 items-center gap-2 text-sm text-accent disabled:opacity-50"
            onClick={onBrief}
            disabled={briefing}
          >
            <Sparkles className="size-4" />
            {briefing ? "Reading the thread" : brief ? "Brief again" : "Brief with SCALVS"}
          </button>
          {notice ? <p className="mt-2 text-sm text-muted">{notice}</p> : null}
          <ol className="mt-8 border-t border-line">
            {thread.map((item) => (
              <li key={item.id} className="border-b border-line py-6">
                <div className="flex gap-3">
                  <span className="grid size-10 shrink-0 place-items-center border border-line font-mono text-xs">
                    {initials(item.from.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm">
                        {item.from.name} <span className="text-muted">{`<${item.from.email}>`}</span>
                      </p>
                      <time className="font-mono text-xs text-muted" dateTime={item.at}>
                        {formatWhen(item.at)} UTC
                      </time>
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      To {item.to.map((person) => person.name).join(", ") || "—"}
                      {item.cc.length ? ` · Cc ${item.cc.map((person) => person.name).join(", ")}` : ""}
                    </p>
                  </div>
                </div>
                <p translate="no" className="mt-4 whitespace-pre-wrap text-base leading-normal">{item.id === message.id && openedBody ? openedBody : item.body}</p>
                {item.id === message.id && links.length ? (
                  <ul className="mt-3 space-y-1">
                    {links.map((link) => (
                      <li key={link.href}>
                        <button type="button" className="text-left font-mono text-xs text-accent" onClick={() => onOpenLink?.(link.href)}>
                          {link.href}
                        </button>
                        {link.reason ? <span className="ml-2 text-xs text-muted">{link.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.extra?.cloudLinks?.length ? (
                  <ul className="mt-3 space-y-1">
                    {item.extra.cloudLinks.map((link) => (
                      <li key={link.href}>
                        <button type="button" className="font-mono text-xs text-accent" onClick={() => onOpenLink?.(link.href)}>
                          {link.name} · Cumulus://Cloud
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.attachments?.length ? (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {item.attachments.map((file) => (
                      <li key={file.id ?? file.name}>
                        <button
                          type="button"
                          className="inline-flex h-9 items-center gap-2 border border-line px-2 text-sm"
                          onClick={() => onOpenAttachment?.(file, item.id)}
                        >
                          <Paperclip className="size-3.5 text-muted" />
                          {file.name}
                          <span className="font-mono text-xs text-muted">{formatSize(file.size)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
          {message.from.email && !knownContact ? (
            <button type="button" className="mt-4 text-sm text-accent" onClick={onSaveContact}>
              Save {message.from.name} to contacts
            </button>
          ) : null}
          {inline ? (
            <div className="mt-6 border border-line">
              <Composer
                form={inline}
                error={composeError}
                assisting={assisting}
                onChange={onChange}
                onSend={onSend}
                onSave={onSave}
                onClose={onCloseComposer}
                onAssist={onAssist}
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
