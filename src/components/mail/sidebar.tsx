import {
  Archive,
  ArrowUpRight,
  CalendarDays,
  Clock,
  FileText,
  Inbox,
  ListTodo,
  Send,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { ME, BOXES, type BoxId, type ViewId } from "@/lib/mail/model";
import { draftCount, quota, unreadInBox } from "@/lib/mail/logic";
import type { MailMessage } from "@/lib/mail/model";
import type { MailProfile } from "@/lib/mail/snapshot";

const ICONS = {
  inbox: Inbox,
  snoozed: Clock,
  outbox: ArrowUpRight,
  starred: Star,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  trash: Trash2,
} as const;

type Props = {
  open: boolean;
  view: ViewId;
  box: BoxId;
  messages: MailMessage[];
  me?: MailProfile;
  openTasks: number;
  onClose: () => void;
  onView: (view: ViewId) => void;
  onBox: (box: BoxId) => void;
  onAccount: () => void;
};

export function Sidebar({ open, view, box, messages, me = ME, openTasks, onClose, onView, onBox, onAccount }: Props) {
  const used = quota(messages, me.quotaGb);
  const views: { id: ViewId; label: string; count?: number }[] = [
    { id: "mail", label: "Mail" },
    { id: "calendar", label: "Calendar" },
    { id: "contacts", label: "Contacts" },
    { id: "tasks", label: "Architect", count: openTasks },
  ];

  return (
    <aside className="nav-pane" data-open={open ? "true" : "false"} aria-label="Mailbox">
      <div className="flex items-center justify-between px-4 py-3 md:hidden">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Folders</p>
        <button type="button" className="grid size-11 place-items-center" onClick={onClose} aria-label="Close folders">
          <X className="size-4" />
        </button>
      </div>
      <nav className="flex flex-col border-b border-line" aria-label="Cumulus">
        {views.map((item) => {
          const Icon = item.id === "calendar" ? CalendarDays : item.id === "contacts" ? Users : item.id === "tasks" ? ListTodo : Inbox;
          const selected = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onView(item.id)}
              className={`flex h-12 items-center gap-3 border-l-2 px-4 text-left text-sm ${selected ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"}`}
            >
              <Icon className="size-4" />
              <span className="flex-1">{item.label}</span>
              {item.count ? <span className="font-mono text-xs">{item.count}</span> : null}
            </button>
          );
        })}
      </nav>
      {view === "mail" ? (
        <nav className="flex flex-col" aria-label="Folders">
          {BOXES.map((item) => {
            const Icon = ICONS[item.id];
            const count = item.id === "drafts" ? draftCount(messages) : unreadInBox(messages, item.id);
            const selected = box === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onBox(item.id)}
                aria-current={selected ? "page" : undefined}
                className={`flex h-12 items-center gap-3 border-l-2 px-4 text-left text-sm ${selected ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                <Icon className="size-4" />
                <span className="flex-1">{item.label}</span>
                {count > 0 ? <span className="font-mono text-xs text-ink">{count}</span> : null}
              </button>
            );
          })}
        </nav>
      ) : (
        <p className="px-4 py-6 text-sm leading-normal text-muted">
          {view === "calendar"
            ? "Holds that belong to this CID. Spectre can read titles only while you allow it."
            : view === "contacts"
              ? "People already in this mailbox. External addresses leave the encrypted channel."
              : "Architect keeps the task. It does not send the mail."}
        </p>
      )}
      <button type="button" onClick={onAccount} className="mt-auto w-full border-t border-line px-4 py-4 text-left">
        <span className="block text-sm">{me.name}</span>
        <span className="mt-1 block truncate font-mono text-xs text-muted">{me.email}</span>
        <span className="mt-3 block h-1 bg-line" aria-hidden="true">
          <span className="block h-1 bg-accent" style={{ width: `${used.pct}%` }} />
        </span>
        <span className="mt-2 block text-xs text-muted">{used.label} shared with Drive</span>
      </button>
    </aside>
  );
}
