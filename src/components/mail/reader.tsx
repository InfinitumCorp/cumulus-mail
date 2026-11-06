import { Archive, ChevronLeft, Clock, Forward, ListTodo, Lock, Paperclip, Reply, ReplyAll, Shield, Sparkles, Star, Trash2 } from "lucide-react";
import type { MailMessage } from "@/lib/mail/model";
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
          </>
        )}
        <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={onUnread}>
          Unread
        </button>
        {message.from.email !== ME.email ? (
          <button type="button" className="inline-flex h-11 items-center px-3 text-sm hover:text-accent" onClick={onMute}>
            Mute
          </button>
        ) : null}
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={onTask}>
          <ListTodo className="size-4" />
          Architect
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6 md:px-8">
          <p className="font-mono text-xs uppercase tracking-wide text-muted">{message.labels.join(" · ") || "Mail"}</p>
          <h2 className="mt-3 text-3xl leading-tight tracking-tight md:text-4xl">{message.subject}</h2>
          <p className={`mt-4 inline-flex items-center gap-2 text-sm ${e2e ? "text-accent" : "text-muted"}`}>
            {e2e ? <Lock className="size-4" /> : <Shield className="size-4" />}
            {e2e ? "End-to-end · Cumulus to Cumulus" : "Encrypted at rest · leaves Cumulus when it is delivered"}
          </p>
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
              <p className="mt-2 whitespace-pre-wrap text-sm leading-normal">{brief}</p>
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
                <p className="mt-4 whitespace-pre-wrap text-base leading-normal">{item.body}</p>
                {item.attachments?.length ? (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {item.attachments.map((file) => (
                      <li key={file.name} className="inline-flex h-9 items-center gap-2 border border-line px-2 text-sm">
                        <Paperclip className="size-3.5 text-muted" />
                        {file.name}
                        <span className="font-mono text-xs text-muted">{formatSize(file.size)}</span>
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
