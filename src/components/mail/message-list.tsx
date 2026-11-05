import { Star } from "lucide-react";
import type { BoxId, MailMessage } from "@/lib/mail/model";
import { formatShort, initials, rowTitle } from "@/lib/mail/logic";

type Props = {
  box: BoxId;
  rows: MailMessage[];
  messages: MailMessage[];
  selectedId: string | null;
  unreadOnly: boolean;
  onUnreadOnly: (value: boolean) => void;
  onOpen: (message: MailMessage) => void;
  onStar: (id: string) => void;
};

const TITLES: Record<BoxId, string> = {
  inbox: "Inbox",
  snoozed: "Snoozed",
  outbox: "Outbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
};

export function MessageList({ box, rows, messages, selectedId, unreadOnly, onUnreadOnly, onOpen, onStar }: Props) {
  return (
    <section className="list-pane" aria-label={TITLES[box]}>
      <div className="flex h-14 items-center justify-between border-b border-line px-4">
        <h2 className="text-lg tracking-tight">{TITLES[box]}</h2>
        <button
          type="button"
          onClick={() => onUnreadOnly(!unreadOnly)}
          className={`h-9 px-2 text-sm ${unreadOnly ? "text-accent" : "text-muted hover:text-ink"}`}
          aria-pressed={unreadOnly}
        >
          Unread
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-sm text-muted">Nothing in {TITLES[box].toLowerCase()}.</p>
        ) : (
          rows.map((message) => {
            const threadCount = messages.filter(
              (item) => item.threadId === message.threadId && item.folder !== "drafts",
            ).length;
            const unread = messages.some(
              (item) => item.threadId === message.threadId && item.unread && item.folder === message.folder,
            );
            const snippet = message.body.replace(/\s+/g, " ").trim();
            const selected = message.id === selectedId;
            return (
              <div
                key={message.id}
                className={`flex border-b border-line border-l-2 ${selected ? "border-l-accent bg-accent/10" : "border-l-transparent"}`}
              >
                <button type="button" onClick={() => onOpen(message)} className="flex min-w-0 flex-1 gap-3 px-3 py-3 text-left">
                  <span className="mt-0.5 grid size-10 shrink-0 place-items-center border border-line font-mono text-xs">
                    {initials(message.from.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={`truncate text-sm ${unread ? "text-ink" : "text-muted"}`}>{rowTitle(message)}</span>
                      <span className="shrink-0 font-mono text-xs text-muted">{formatShort(message.at)}</span>
                    </span>
                    <span className={`mt-1 flex items-baseline gap-2 text-sm ${unread ? "text-ink" : "text-muted"}`}>
                      <span className="truncate">{message.subject}</span>
                      {threadCount > 1 ? <span className="shrink-0 font-mono text-xs">{threadCount}</span> : null}
                    </span>
                    <span className="mt-1 block truncate text-sm text-muted">{snippet}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="grid w-11 shrink-0 place-items-center"
                  aria-label={message.starred ? "Remove star" : "Star"}
                  aria-pressed={message.starred}
                  onClick={() => onStar(message.id)}
                >
                  <Star className={`size-4 ${message.starred ? "fill-accent text-accent" : "text-muted"}`} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
