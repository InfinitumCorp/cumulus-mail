import { Check, Plus, X } from "lucide-react";
import { ME, type CalEvent, type ConductorTask, type Contact, type MailRule, type RuleAction } from "@/lib/mail/model";

export function CalendarPanel({ events }: { events: CalEvent[] }) {
  return (
    <div className="aux-pane overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Calendar</p>
        <h2 className="mt-3 text-4xl tracking-tight">Coming up</h2>
        <p className="mt-3 max-w-lg text-muted">Encrypted with this mailbox. Spectre sees titles and times only while the Firmament grant stands.</p>
        <ol className="mt-8">
          {events.map((event) => (
            <li key={event.id} className="grid gap-2 border-t border-line py-6 md:grid-cols-[200px_1fr] md:gap-8">
              <p className="font-mono text-xs text-accent">{event.whenLabel}</p>
              <div>
                <h3 className="text-2xl tracking-tight">{event.title}</h3>
                <p className="mt-2 text-sm">{event.with}</p>
                <p className="mt-1 text-sm text-muted">{event.where}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function ContactsPanel({
  contacts,
  query,
  onWrite,
}: {
  contacts: Contact[];
  query: string;
  onWrite: (contact: Contact) => void;
}) {
  const q = query.trim().toLowerCase();
  const rows = contacts.filter((contact) =>
    !q || [contact.name, contact.email, contact.org, contact.note].join(" ").toLowerCase().includes(q),
  );
  return (
    <div className="aux-pane overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Contacts</p>
        <h2 className="mt-3 text-4xl tracking-tight">People</h2>
        <ul className="mt-8">
          {rows.length === 0 ? <li className="border-t border-line py-6 text-sm text-muted">No one matches.</li> : null}
          {rows.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-start justify-between gap-4 border-t border-line py-5">
              <div className="min-w-0">
                <p className="text-lg tracking-tight">{contact.name}</p>
                <p className="mt-1 font-mono text-xs text-muted">{contact.email}</p>
                <p className="mt-2 text-sm">{contact.org}</p>
                <p className="mt-1 text-sm text-muted">{contact.note}</p>
              </div>
              <button type="button" className="inline-flex h-11 items-center border border-line px-4 text-sm hover:border-ink" onClick={() => onWrite(contact)}>
                Write
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function TasksPanel({ tasks, onToggle }: { tasks: ConductorTask[]; onToggle: (id: string) => void }) {
  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);
  return (
    <div className="aux-pane overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">:\ARCHITECT\</p>
        <h2 className="mt-3 text-4xl tracking-tight">Waiting on you</h2>
        <p className="mt-3 max-w-lg text-muted">A task is a promise you already made in mail. Architect keeps score. It does not send.</p>
        <ul className="mt-8">
          {open.length === 0 ? <li className="border-t border-line py-6 text-sm text-muted">Nothing is waiting.</li> : null}
          {[...open, ...done].map((task) => (
            <li key={task.id} className="border-t border-line">
              <button type="button" onClick={() => onToggle(task.id)} className="flex w-full items-start gap-4 py-5 text-left">
                <span className={`mt-0.5 grid size-6 shrink-0 place-items-center border ${task.done ? "border-ink bg-ink text-paper" : "border-line"}`}>
                  {task.done ? <Check className="size-3.5" /> : null}
                </span>
                <span>
                  <span className={`block text-lg tracking-tight ${task.done ? "text-muted line-through" : ""}`}>{task.title}</span>
                  <span className="mt-1 block text-sm text-muted">{task.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const ALIAS_WORDS = ["north", "quiet", "glass", "harbor", "lumen", "cedar", "field", "orbit", "paper", "signal"];

export function newAlias(): string {
  const a = ALIAS_WORDS[Math.floor(Math.random() * ALIAS_WORDS.length)] ?? "north";
  const b = ALIAS_WORDS[Math.floor(Math.random() * ALIAS_WORDS.length)] ?? "quiet";
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${a}.${b}.${n}@cumulusmail.cloud`;
}

export function AccountPanel({
  aliases,
  quotaLabel,
  signature,
  rules,
  onClose,
  onAddAlias,
  onSignature,
  onAddRule,
  onRemoveRule,
}: {
  aliases: string[];
  quotaLabel: string;
  signature: string;
  rules: MailRule[];
  onClose: () => void;
  onAddAlias: (alias: string) => void;
  onSignature: (signature: string) => void;
  onAddRule: (rule: MailRule) => void;
  onRemoveRule: (id: string) => void;
}) {
  return (
    <div className="scrim fixed inset-0 z-40 flex items-end justify-center md:items-center md:p-6" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-labelledby="account-title"
        className="max-h-dvh w-full overflow-y-auto bg-paper md:max-w-lg md:border md:border-line"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <p className="font-mono text-xs uppercase tracking-wide text-muted">Cumulus://ID</p>
          <button type="button" className="grid size-11 place-items-center" onClick={onClose} aria-label="Close account">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-6">
          <h2 id="account-title" className="text-3xl tracking-tight">{ME.name}</h2>
          <p className="mt-2 font-mono text-sm text-muted">{ME.cid}</p>
          <dl className="mt-8 border-t border-line text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-4">
              <dt className="text-muted">Address</dt>
              <dd className="font-mono text-xs">{ME.email}</dd>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-4">
              <dt className="text-muted">Plan</dt>
              <dd>{ME.plan} · {quotaLabel}</dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Aliases</dt>
              <dd className="mt-3 flex flex-col gap-2">
                {aliases.map((alias) => (
                  <span key={alias} className="font-mono text-xs">{alias}</span>
                ))}
                <button
                  type="button"
                  className="mt-2 inline-flex h-11 items-center gap-2 self-start border border-line px-3 text-sm hover:border-ink"
                  onClick={() => onAddAlias(newAlias())}
                >
                  <Plus className="size-4" />
                  Disposable alias
                </button>
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Signature</dt>
              <dd className="mt-3">
                <textarea
                  value={signature}
                  onChange={(event) => onSignature(event.target.value)}
                  aria-label="Signature"
                  className="min-h-24 w-full border border-line bg-transparent px-3 py-2 text-sm outline-none"
                />
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Rules</dt>
              <dd className="mt-3 flex flex-col gap-3">
                {rules.length === 0 ? <p className="text-sm text-muted">None yet. A rule runs when mail arrives in the inbox.</p> : null}
                {rules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>From {rule.from} · {rule.action === "label" ? rule.label : rule.action}</span>
                    <button type="button" className="text-muted hover:text-ink" onClick={() => onRemoveRule(rule.id)} aria-label={`Remove rule for ${rule.from}`}>
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const from = String(data.get("from") ?? "").trim();
                    const action = String(data.get("action") ?? "star") as RuleAction;
                    const label = String(data.get("label") ?? "").trim();
                    if (!from) return;
                    if (action === "label" && !label) return;
                    onAddRule({ id: `r-${Date.now().toString(36)}`, from, action, label });
                    event.currentTarget.reset();
                  }}
                >
                  <input name="from" placeholder="From contains" aria-label="Rule match" className="h-11 border border-line bg-transparent px-3 text-sm outline-none" />
                  <div className="flex gap-2">
                    <select name="action" aria-label="Rule action" className="h-11 flex-1 border border-line bg-transparent px-2 text-sm" defaultValue="star">
                      <option value="star">Star</option>
                      <option value="archive">Archive</option>
                      <option value="label">Label</option>
                    </select>
                    <input name="label" placeholder="Label" aria-label="Rule label" className="h-11 w-28 border border-line bg-transparent px-3 text-sm outline-none" />
                  </div>
                  <button type="submit" className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink">
                    Add rule
                  </button>
                </form>
              </dd>
            </div>
          </dl>
          <p className="mt-6 text-sm leading-normal text-muted">
            Every mailbox is encrypted at rest. Mail between Cumulus://Mail accounts is end-to-end encrypted. Cumulus://Mail is never scanned for ads and never sold.
          </p>
        </div>
      </div>
    </div>
  );
}
