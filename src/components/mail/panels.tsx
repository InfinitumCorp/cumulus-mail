import { Check, Plus, X } from "lucide-react";
import { useDialogFocus } from "@/lib/a11y/focus";
import { BillingControls } from "./billing-controls";
import { SignedInDevices } from "./signed-in-devices";
import { mailDomain } from "@/lib/mail/domain";
import { newAlias } from "@/lib/mail/alias";
import { bridgeDesign } from "@/lib/mail/bridge";
import { identityPosture } from "@/lib/mail/identity";
import { addressAllowed, expectedTxt, MAX_DOMAINS, type MailSettings } from "@/lib/mail/settings";
import { cleanDomain } from "@/lib/mail/routing";
import { ME, type CalEvent, type ArchitectTask, type Contact, type CustomFolder, type MailRule, type RuleAction } from "@/lib/mail/model";
import { parseSieve } from "@/lib/mail/sieve";
import { planUsage } from "@/lib/mail/plans";
import type { MailProfile } from "@/lib/mail/snapshot";

function sieveProblem(source: string, folders: CustomFolder[]): string {
  if (!source.trim()) return "";
  try {
    parseSieve(source, folders);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "The filter could not be read.";
  }
}

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
  onSave,
}: {
  contacts: Contact[];
  query: string;
  onWrite: (contact: Contact) => void;
  onSave?: (contact: Contact) => void;
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
                {contact.phone ? <p className="mt-1 text-sm text-muted">{contact.phone}</p> : null}
                {contact.address ? <p className="mt-1 text-sm text-muted">{contact.address}</p> : null}
                {contact.publicKey ? <p className="mt-1 font-mono text-xs text-muted">OpenPGP key on file</p> : null}
              </div>
              <button type="button" className="inline-flex h-11 items-center border border-line px-4 text-sm hover:border-ink" onClick={() => onWrite(contact)}>
                Write
              </button>
            </li>
          ))}
        </ul>
        {onSave ? (
          <form
            className="mt-8 border-t border-line py-6"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const email = String(data.get("email") ?? "").trim().toLowerCase();
              const existing = contacts.find((contact) => contact.email.toLowerCase() === email);
              if (!existing) return;
              onSave({
                ...existing,
                phone: String(data.get("phone") ?? "").trim(),
                address: String(data.get("address") ?? "").trim(),
                publicKey: String(data.get("publicKey") ?? "").trim(),
              });
              event.currentTarget.reset();
            }}
          >
            <p className="font-mono text-xs uppercase tracking-wide text-muted">Encrypted fields</p>
            <p className="mt-2 max-w-lg text-sm text-muted">Phone, postal address, and an OpenPGP public key are sealed with this mailbox.</p>
            <div className="mt-4 flex max-w-lg flex-col gap-2">
              <input name="email" aria-label="Contact email" placeholder="Existing address" className="h-11 border border-line bg-transparent px-3 text-sm outline-none" />
              <input name="phone" aria-label="Phone" placeholder="Phone" className="h-11 border border-line bg-transparent px-3 text-sm outline-none" />
              <input name="address" aria-label="Postal address" placeholder="Postal address" className="h-11 border border-line bg-transparent px-3 text-sm outline-none" />
              <textarea name="publicKey" aria-label="OpenPGP public key" placeholder="OpenPGP public key" className="min-h-24 border border-line bg-transparent px-3 py-2 font-mono text-xs outline-none" />
              <button type="submit" className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink">
                Save encrypted fields
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

export function TasksPanel({ tasks, onToggle }: { tasks: ArchitectTask[]; onToggle: (id: string) => void }) {
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

export function AccountPanel({
  me = ME,
  aliases,
  quotaLabel,
  signature,
  rules,
  settings,
  onClose,
  onAddAlias,
  onSignature,
  onAddRule,
  onRemoveRule,
  onSettings,
  onExport,
  onImport,
  onCheckDomain,
  domainNote = "",
  pgpPublic = "",
  onCreateKey,
  keyError = "",
  usage,
}: {
  usage?: { folders: number; messages: number };
  me?: MailProfile;
  aliases: string[];
  quotaLabel: string;
  signature: string;
  rules: MailRule[];
  settings: MailSettings;
  onClose: () => void;
  onAddAlias: (alias: string) => void;
  onSignature: (signature: string) => void;
  onAddRule: (rule: MailRule) => void;
  onRemoveRule: (id: string) => void;
  onSettings: (settings: MailSettings) => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onCheckDomain: (domain: string) => void;
  domainNote?: string;
  pgpPublic?: string;
  onCreateKey: (passphrase: string) => void;
  keyError?: string;
}) {
  const posture = identityPosture();
  const bridge = bridgeDesign();
  const dialog = useDialogFocus<HTMLDivElement>(true, onClose);
  return (
    <div className="scrim fixed inset-0 z-40 flex items-end justify-center md:items-center md:p-6" role="presentation" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
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
          <h2 id="account-title" className="text-3xl tracking-tight">{me.name}</h2>
          <p className="mt-2 font-mono text-sm text-muted">{me.cid}</p>
          <dl className="mt-8 border-t border-line text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-4">
              <dt className="text-muted">Address</dt>
              <dd className="font-mono text-xs">{me.email}</dd>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-4">
              <dt className="text-muted">Plan</dt>
              <dd>
                {me.plan} · {quotaLabel}
                {me.limits && usage ? (
                  <ul aria-label="Plan usage" className="mt-3 flex flex-col gap-1 text-xs">
                    {planUsage(me.limits, {
                      aliases: aliases.length,
                      domains: settings.domains.length,
                      folders: usage.folders,
                      messages: usage.messages,
                      usedBytes: me.usedBytes,
                    }).map((row) => (
                      <li key={row.key} className="flex justify-between gap-3">
                        <span className="text-muted">{row.label}</span>
                        <span className={row.full ? "font-mono text-accent" : "font-mono"}>
                          {row.text}
                          {row.full ? " (limit reached)" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <BillingControls />
              </dd>
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
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const email = String(data.get("address") ?? "");
                    const error = addressAllowed(email, settings, mailDomain());
                    if (error) return;
                    onAddAlias(email.trim().toLowerCase());
                    event.currentTarget.reset();
                  }}
                >
                  <input name="address" aria-label="Additional address" placeholder="Additional address" className="h-11 min-w-0 flex-1 border border-line bg-transparent px-3 text-sm outline-none" />
                  <button type="submit" className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink">
                    Add
                  </button>
                </form>
              </dd>
            </div>
            <SignedInDevices />
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
            <div className="border-b border-line py-4">
              <dt className="text-muted">Auto-reply</dt>
              <dd className="mt-3 flex flex-col gap-2">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.autoReply.enabled}
                    onChange={(event) => onSettings({ ...settings, autoReply: { ...settings.autoReply, enabled: event.target.checked } })}
                  />
                  On
                </label>
                <input
                  aria-label="Auto-reply subject"
                  value={settings.autoReply.subject}
                  onChange={(event) => onSettings({ ...settings, autoReply: { ...settings.autoReply, subject: event.target.value } })}
                  className="h-11 border border-line bg-transparent px-3 text-sm outline-none"
                />
                <textarea
                  aria-label="Auto-reply"
                  value={settings.autoReply.body}
                  onChange={(event) => onSettings({ ...settings, autoReply: { ...settings.autoReply, body: event.target.value } })}
                  className="min-h-20 border border-line bg-transparent px-3 py-2 text-sm outline-none"
                />
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Sieve</dt>
              <dd className="mt-3">
                <textarea
                  aria-label="Sieve filter"
                  value={settings.sieve}
                  onChange={(event) => onSettings({ ...settings, sieve: event.target.value })}
                  placeholder={'if header :contains "From" "vyral" {\n  fileinto "archive";\n}'}
                  className="min-h-28 w-full border border-line bg-transparent px-3 py-2 font-mono text-xs outline-none"
                />
                <p className="mt-2 text-xs text-muted">
                  fileinto takes inbox, archive, trash, Spam, label:Name, or the name of one of your folders.
                </p>
                {sieveProblem(settings.sieve, settings.folders) ? (
                  <p role="alert" className="mt-1 text-xs">
                    {sieveProblem(settings.sieve, settings.folders)} The filter is saved but not applied until this is fixed.
                  </p>
                ) : null}
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Domains</dt>
              <dd className="mt-3 flex flex-col gap-3">
                {settings.domains.map((domain) => (
                  <div key={domain.domain} className="text-sm">
                    <p className="font-mono text-xs">{domain.domain}</p>
                    <p className="mt-1 text-muted">{domain.verified ? "Verified" : "Pending DNS"} · TXT {domain.txtName} = {domain.txtValue}</p>
                    <label className="mt-2 inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={domain.catchAll}
                        onChange={(event) =>
                          onSettings({
                            ...settings,
                            domains: settings.domains.map((item) => (item.domain === domain.domain ? { ...item, catchAll: event.target.checked } : item)),
                          })
                        }
                      />
                      Catch-all
                    </label>
                    <button type="button" className="ml-3 text-accent" onClick={() => onCheckDomain(domain.domain)}>
                      Check DNS
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-muted hover:text-ink"
                      aria-label={`Remove ${domain.domain}`}
                      onClick={() => {
                        if (!window.confirm(`Remove ${domain.domain}? Mail to it will no longer arrive here.`)) return;
                        onSettings({ ...settings, domains: settings.domains.filter((item) => item.domain !== domain.domain) });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {settings.domains.length >= (me.limits?.domains ?? MAX_DOMAINS) ? (
                  <p className="text-sm text-muted">You can add up to {me.limits?.domains ?? MAX_DOMAINS} custom domains. Remove one to add another.</p>
                ) : (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const domain = cleanDomain(String(data.get("domain") ?? ""), mailDomain());
                    if (!domain || settings.domains.some((item) => item.domain === domain)) return;
                    const txt = expectedTxt(domain);
                    onSettings({
                      ...settings,
                      domains: [...settings.domains, { domain, catchAll: false, verified: false, txtName: txt.name, txtValue: txt.value }],
                    });
                    event.currentTarget.reset();
                  }}
                >
                  <input name="domain" aria-label="Custom domain" placeholder="example.com" className="h-11 min-w-0 flex-1 border border-line bg-transparent px-3 text-sm outline-none" />
                  <button type="submit" className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink">
                    Add domain
                  </button>
                </form>
                )}
                {domainNote ? <p className="text-sm text-muted">{domainNote}</p> : null}
              </dd>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-4">
              <dt className="text-muted">Undo send</dt>
              <dd>
                <input
                  aria-label="Undo send seconds"
                  type="number"
                  min={0}
                  max={30}
                  value={settings.undoSendSeconds}
                  onChange={(event) => onSettings({ ...settings, undoSendSeconds: Number(event.target.value) })}
                  className="h-11 w-20 border border-line bg-transparent px-3 text-sm outline-none"
                />
                <span className="ml-2 text-muted">seconds</span>
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Sign-in</dt>
              <dd className="mt-2 text-sm text-muted">
                {posture.note} Factors: {posture.methods.join(", ")}.{" "}
                <a className="text-accent" href={posture.issuer}>
                  {posture.issuer}
                </a>
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">OpenPGP</dt>
              <dd className="mt-3 flex flex-col gap-2">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    onCreateKey(String(data.get("passphrase") ?? ""));
                  }}
                >
                  <input name="passphrase" type="password" aria-label="OpenPGP passphrase" placeholder="Passphrase" className="h-11 min-w-0 flex-1 border border-line bg-transparent px-3 text-sm outline-none" />
                  <button type="submit" className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink">
                    Session key
                  </button>
                </form>
                {keyError ? <p className="text-sm">{keyError}</p> : null}
                {pgpPublic ? (
                  <textarea readOnly aria-label="Session public key" value={pgpPublic} className="min-h-24 border border-line bg-transparent px-3 py-2 font-mono text-xs outline-none" />
                ) : (
                  <p className="text-sm text-muted">The private key stays in this tab. It is not written to the mailbox.</p>
                )}
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Bridge</dt>
              <dd className="mt-2 text-sm text-muted">
                {bridge.reason} IMAP {bridge.imap.host}:{bridge.imap.port}. SMTP {bridge.smtp.host}:{bridge.smtp.port}.
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Backup</dt>
              <dd className="mt-3 flex gap-2">
                <button type="button" className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink" onClick={onExport}>
                  Export
                </button>
                <label className="inline-flex h-11 cursor-pointer items-center border border-line px-3 text-sm hover:border-ink">
                  Import
                  <input
                    type="file"
                    accept="application/json"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void file.text().then(onImport);
                      event.target.value = "";
                    }}
                  />
                </label>
              </dd>
            </div>
            <div className="border-b border-line py-4">
              <dt className="text-muted">Audit</dt>
              <dd className="mt-3 flex flex-col gap-2">
                {settings.audit.length === 0 ? <p className="text-sm text-muted">No mailbox actions recorded in this session.</p> : null}
                {settings.audit.slice(-8).map((event) => (
                  <p key={`${event.at}-${event.action}`} className="text-sm">
                    <span className="font-mono text-xs text-muted">{event.at.slice(0, 16).replace("T", " ")}</span> {event.action}. {event.detail}
                  </p>
                ))}
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
