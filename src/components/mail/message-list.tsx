import { Star } from "lucide-react";
import type { BoxId, CustomFolder, MailMessage } from "@/lib/mail/model";
import { isCustomFolderId } from "@/lib/mail/folders";
import { CATEGORIES, type Category, type Subscription } from "@/lib/mail/categories";

export type InboxTab = "all" | Category | "subscriptions";
import { formatShort, initials, messageSnippet, rowTitle } from "@/lib/mail/logic";

type Props = {
  box: BoxId;
  rows: MailMessage[];
  messages: MailMessage[];
  meEmail?: string;
  selectedId: string | null;
  unreadOnly: boolean;
  picked: string[];
  onUnreadOnly: (value: boolean) => void;
  onOpen: (message: MailMessage) => void;
  onStar: (id: string) => void;
  onTogglePick: (threadId: string) => void;
  onPickAll: (threadIds: string[], on: boolean) => void;
  onArchivePicked: () => void;
  onTrashPicked: () => void;
  onUnreadPicked: () => void;
  onClearPick: () => void;
  onEmptyTrash: () => void;
  folders?: CustomFolder[];
  /** Inbox only. Omit to hide the category row. */
  tab?: InboxTab;
  onTab?: (tab: InboxTab) => void;
  subscriptions?: Subscription[];
  unsubscribedKeys?: string[];
  unsubscribing?: string | null;
  onUnsubscribe?: (subscription: Subscription) => void;
  subscriptionNote?: string;
};

const TITLES: Record<Exclude<BoxId, `folder-${string}`>, string> = {
  inbox: "Inbox",
  snoozed: "Snoozed",
  outbox: "Outbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
  quarantine: "Quarantine",
};

export function MessageList({
  box,
  rows,
  messages,
  meEmail,
  selectedId,
  unreadOnly,
  picked,
  onUnreadOnly,
  onOpen,
  onStar,
  onTogglePick,
  onPickAll,
  onArchivePicked,
  onTrashPicked,
  onUnreadPicked,
  onClearPick,
  onEmptyTrash,
  folders = [],
  tab = "all",
  onTab,
  subscriptions = [],
  unsubscribedKeys = [],
  unsubscribing = null,
  onUnsubscribe,
  subscriptionNote = "",
}: Props) {
  const title = isCustomFolderId(box) ? (folders.find((folder) => folder.id === box)?.name ?? "Folder") : TITLES[box];
  const showTabs = box === "inbox" && Boolean(onTab);
  const visible = rows.map((row) => row.threadId);
  const allPicked = visible.length > 0 && visible.every((id) => picked.includes(id));
  return (
    <section className="list-pane" aria-label={title}>
      <div className="flex h-14 items-center justify-between gap-2 border-b border-line px-4">
        {picked.length ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button type="button" className="h-11 px-2 text-sm md:h-9 text-muted" onClick={onClearPick}>
              {picked.length} selected
            </button>
            {box === "inbox" ? (
              <button type="button" className="h-11 px-2 text-sm md:h-9 hover:text-accent" onClick={onArchivePicked}>
                Archive
              </button>
            ) : null}
            {box !== "trash" ? (
              <button type="button" className="h-11 px-2 text-sm md:h-9 hover:text-accent" onClick={onTrashPicked}>
                Trash
              </button>
            ) : null}
            <button type="button" className="h-11 px-2 text-sm md:h-9 hover:text-accent" onClick={onUnreadPicked}>
              Unread
            </button>
          </div>
        ) : (
          <h2 className="text-lg tracking-tight">{title}</h2>
        )}
        <div className="flex items-center gap-1">
          {box === "trash" && !picked.length ? (
            <button type="button" className="h-11 px-2 text-sm md:h-9 text-muted hover:text-ink" onClick={onEmptyTrash}>
              Empty
            </button>
          ) : null}
          {showTabs && !picked.length ? (
            <button
              type="button"
              onClick={() => onTab?.(tab === "subscriptions" ? "all" : "subscriptions")}
              className={`h-11 px-2 text-sm md:h-9 ${tab === "subscriptions" ? "text-accent" : "text-muted hover:text-ink"}`}
              aria-pressed={tab === "subscriptions"}
            >
              Subscriptions
            </button>
          ) : null}
          {!picked.length ? (
            <button
              type="button"
              onClick={() => onUnreadOnly(!unreadOnly)}
              className={`h-11 px-2 text-sm md:h-9 ${unreadOnly ? "text-accent" : "text-muted hover:text-ink"}`}
              aria-pressed={unreadOnly}
            >
              Unread
            </button>
          ) : (
            <button
              type="button"
              className="h-11 px-2 text-sm md:h-9 text-muted hover:text-ink"
              aria-pressed={allPicked}
              onClick={() => onPickAll(visible, !allPicked)}
            >
              All
            </button>
          )}
        </div>
      </div>
      {showTabs ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2" role="tablist" aria-label="Inbox categories">
          {([{ id: "all", label: "All" }, ...CATEGORIES] as { id: InboxTab; label: string }[]).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onTab?.(item.id)}
              className={`h-11 shrink-0 border-b-2 px-2 text-sm md:h-10 ${tab === item.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {showTabs && tab === "subscriptions" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {subscriptionNote ? (
            <p role="status" className="border-b border-line px-4 py-2 text-sm">
              {subscriptionNote}
            </p>
          ) : null}
          {subscriptions.length === 0 ? (
            <p className="px-4 py-10 text-sm text-muted">No mailing lists in this mailbox.</p>
          ) : (
            <ul>
              {subscriptions.map((item) => {
                const done = unsubscribedKeys.includes(item.key);
                const how =
                  item.option?.kind === "one-click"
                    ? "One-click"
                    : item.option?.kind === "mailto"
                      ? "By email"
                      : item.option?.kind === "link"
                        ? "On their site"
                        : "No unsubscribe link";
                return (
                  <li key={item.key} className="flex items-center gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{item.name}</p>
                      <p className="truncate font-mono text-xs text-muted">{item.email}</p>
                      <p className="mt-1 text-xs text-muted">
                        {item.count} {item.count === 1 ? "message" : "messages"} · {how}
                      </p>
                    </div>
                    {done ? (
                      <span className="text-xs text-muted">Unsubscribed</span>
                    ) : item.option ? (
                      <button
                        type="button"
                        disabled={unsubscribing === item.key}
                        onClick={() => onUnsubscribe?.(item)}
                        className="h-9 shrink-0 border border-line px-3 text-sm hover:text-accent disabled:opacity-50"
                      >
                        {unsubscribing === item.key ? "Working…" : "Unsubscribe"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-sm text-muted">Nothing in {title.toLowerCase()}.</p>
        ) : (
          rows.map((message) => {
            const threadCount = messages.filter(
              (item) => item.threadId === message.threadId && item.folder !== "drafts",
            ).length;
            const unread = messages.some(
              (item) => item.threadId === message.threadId && item.unread && item.folder === message.folder,
            );
            const snippet = messageSnippet(message.body);
            const selected = message.id === selectedId;
            return (
              <div
                key={message.id}
                data-row-id={message.id}
                aria-current={selected ? "true" : undefined}
                className={`flex border-b border-line border-l-2 ${selected ? "border-l-accent bg-accent/10" : "border-l-transparent"}`}
              >
                <label className="grid w-11 shrink-0 place-items-center md:w-10">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={picked.includes(message.threadId)}
                    aria-label={`Select ${message.subject || "conversation"}`}
                    onChange={() => onTogglePick(message.threadId)}
                  />
                </label>
                <button type="button" onClick={() => onOpen(message)} className="flex min-w-0 flex-1 gap-3 px-3 py-3 text-left">
                  <span className="mt-0.5 grid size-10 shrink-0 place-items-center border border-line font-mono text-xs">
                    {initials(message.from.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={`truncate text-sm ${unread ? "text-ink" : "text-muted"}`}>{rowTitle(message, meEmail)}</span>
                      <span className="shrink-0 font-mono text-xs text-muted">{formatShort(message.at)}</span>
                    </span>
                    <span className={`mt-1 flex items-baseline gap-2 text-sm ${unread ? "text-ink" : "text-muted"}`}>
                      <span translate="no" className="truncate">{message.subject}</span>
                      {threadCount > 1 ? <span className="shrink-0 font-mono text-xs">{threadCount}</span> : null}
                    </span>
                    <span translate="no" className="mt-1 block truncate text-sm text-muted">{snippet}</span>
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
      )}
    </section>
  );
}
