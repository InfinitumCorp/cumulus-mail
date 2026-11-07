import { useEffect, useState } from "react";
import { Menu, Search, SquarePen } from "lucide-react";
import { briefThread } from "@/lib/mail/brief";
import {
  briefKey,
  audienceLabel,
  usesSampleMailDomain,
  listThreads,
  parsePeople,
  peopleToField,
  planDelivery,
  quota,
  quote,
  threadOf,
  tomorrowMorning,
  transcript,
  trashThreads,
  validEmail,
  withSignature,
  applyRules,
  archiveThreads,
  emptyTrash,
  markThreadUnread,
} from "@/lib/mail/logic";
import { EVENTS, ME, type BoxId, type MailMessage, type MailRule, type ViewId } from "@/lib/mail/model";
import { useMail } from "@/lib/mail/store";
import { Composer, type DraftForm } from "./composer";
import { MessageList } from "./message-list";
import { AccountPanel, CalendarPanel, ContactsPanel, TasksPanel } from "./panels";
import { Reader } from "./reader";
import { Sidebar } from "./sidebar";

function visibleThread(messages: MailMessage[], selected: MailMessage | null): MailMessage[] {
  if (!selected || selected.folder === "drafts") return [];
  return messages
    .filter((message) => {
      if (message.threadId !== selected.threadId || message.folder === "drafts") return false;
      if (message.folder === "trash" && selected.folder !== "trash") return false;
      return true;
    })
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function MailApp() {
  const messages = useMail((s) => s.messages);
  const aliases = useMail((s) => s.aliases);
  const briefs = useMail((s) => s.briefs);
  const tasks = useMail((s) => s.tasks);
  const contacts = useMail((s) => s.contacts);
  const signature = useMail((s) => s.signature);
  const rules = useMail((s) => s.rules);
  const hydrate = useMail((s) => s.hydrate);
  const markThreadRead = useMail((s) => s.markThreadRead);
  const toggleStar = useMail((s) => s.toggleStar);
  const move = useMail((s) => s.move);
  const remove = useMail((s) => s.remove);
  const saveMessage = useMail((s) => s.saveMessage);
  const addAlias = useMail((s) => s.addAlias);
  const saveBrief = useMail((s) => s.saveBrief);
  const addTask = useMail((s) => s.addTask);
  const toggleTask = useMail((s) => s.toggleTask);
  const addContact = useMail((s) => s.addContact);
  const snooze = useMail((s) => s.snooze);
  const setSignature = useMail((s) => s.setSignature);
  const addRule = useMail((s) => s.addRule);
  const removeRule = useMail((s) => s.removeRule);
  const replaceMessages = useMail((s) => s.replaceMessages);
  const replaceRules = useMail((s) => s.replaceRules);

  const [view, setView] = useState<ViewId>("mail");
  const [box, setBox] = useState<BoxId>("inbox");
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [composer, setComposer] = useState<DraftForm | null>(null);
  const [composeError, setComposeError] = useState("");
  const [briefing, setBriefing] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [notice, setNotice] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [undo, setUndo] = useState<{ label: string; messages: MailMessage[]; rules: MailRule[] } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  function remember(label: string) {
    const snap = useMail.getState();
    setUndo({
      label,
      messages: snap.messages.map((message) => ({ ...message })),
      rules: snap.rules.map((rule) => ({ ...rule })),
    });
  }

  function undoLast() {
    if (!undo) return;
    replaceMessages(undo.messages);
    replaceRules(undo.rules);
    setUndo(null);
  }

  useEffect(() => {
    const next = messages
      .map((message) => (message.snoozeUntil ? Date.parse(message.snoozeUntil) : 0))
      .filter((time) => time > Date.now())
      .sort((a, b) => a - b)[0];
    if (!next) return;
    const wait = Math.min(next - Date.now() + 40, 2_147_000_000);
    const timer = window.setTimeout(() => setTick((value) => value + 1), wait);
    return () => window.clearTimeout(timer);
  }, [messages]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest("input, textarea, select") || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "c") {
        event.preventDefault();
        writeNew();
      } else if (event.key === "r" && reading) {
        event.preventDefault();
        reply();
      } else if (event.key === "e" && reading && reading.folder !== "trash") {
        event.preventDefault();
        moveSelected(reading.id, "archive");
      } else if (event.key === "#" && reading && reading.folder !== "trash") {
        event.preventDefault();
        moveSelected(reading.id, "trash");
      } else if (event.key === "z") {
        event.preventDefault();
        undoLast();
      } else if (event.key === "u" && reading) {
        event.preventDefault();
        remember("Marked as unread.");
        replaceMessages(markThreadUnread(messages, reading.threadId));
        setSelectedId(null);
      } else if (event.key === "x" && (reading || rows[0])) {
        event.preventDefault();
        const threadId = reading?.threadId ?? rows[0]?.threadId;
        if (threadId) setPicked((current) => (current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId]));
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const index = rows.findIndex((row) => row.id === selectedId);
        const next = event.key === "j" ? rows[index + 1] ?? rows[0] : rows[index - 1] ?? rows[rows.length - 1];
        if (next) openRow(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const rows = listThreads(messages, box, query, unreadOnly);
  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const reading = selected && selected.folder !== "drafts" ? selected : null;
  const thread = visibleThread(messages, reading);
  const briefText = thread.length ? briefs[briefKey(thread)] ?? "" : "";
  const openTasks = tasks.filter((task) => !task.done).length;
  const modal = composer?.placement === "modal" ? composer : null;

  function openRow(message: MailMessage) {
    setNavOpen(false);
    setNotice("");
    setBriefError("");
    if (message.folder === "drafts") {
      setSelectedId(null);
      setComposer({
        draftId: message.id,
        threadId: message.threadId,
        placement: "modal",
        to: peopleToField(message.to),
        cc: peopleToField(message.cc),
        subject: message.subject,
        body: message.body,
        attachments: message.attachments ?? [],
      });
      return;
    }
    setSelectedId(message.id);
    markThreadRead(message.threadId);
  }

  function reply() {
    if (!reading) return;
    const source = [...thread].reverse().find((message) => message.from.email !== ME.email) ?? reading;
    const to = source.from.email === ME.email ? source.to : [source.from];
    setComposeError("");
    setComposer({
      placement: "inline",
      threadId: source.threadId,
      to: peopleToField(to),
      cc: "",
      subject: source.subject.startsWith("Re:") ? source.subject : `Re: ${source.subject}`,
      body: quote(source),
      attachments: [],
    });
  }

  function replyAll() {
    if (!reading) return;
    const source = [...thread].reverse().find((message) => message.from.email !== ME.email) ?? reading;
    const mine = ME.email.toLowerCase();
    const others = [...source.to, ...source.cc].filter((person) => person.email.toLowerCase() !== mine && person.email.toLowerCase() !== source.from.email.toLowerCase());
    const to = source.from.email.toLowerCase() === mine ? source.to : [source.from];
    const cc = source.from.email.toLowerCase() === mine ? source.cc.filter((person) => person.email.toLowerCase() !== mine) : others;
    setComposeError("");
    setComposer({
      placement: "inline",
      threadId: source.threadId,
      to: peopleToField(to),
      cc: peopleToField(cc),
      subject: source.subject.startsWith("Re:") ? source.subject : `Re: ${source.subject}`,
      body: quote(source),
      attachments: [],
    });
  }

  function forward() {
    if (!reading) return;
    setComposeError("");
    setComposer({
      placement: "modal",
      threadId: reading.threadId,
      to: "",
      cc: "",
      subject: reading.subject.startsWith("Fw:") ? reading.subject : `Fw: ${reading.subject}`,
      body: quote(reading),
      attachments: reading.attachments ?? [],
    });
  }

  function writeNew(to = "", subject = "") {
    setView("mail");
    setComposeError("");
    setComposer({ placement: "modal", to, cc: "", subject, body: "", attachments: [] });
  }

  function send() {
    if (!composer) return;
    const to = parsePeople(composer.to);
    const cc = parsePeople(composer.cc);
    if (to.length === 0 || to.some((person) => !validEmail(person.email))) {
      setComposeError("Add a real address in To.");
      return;
    }
    if (cc.some((person) => !validEmail(person.email))) {
      setComposeError("Check the Cc addresses.");
      return;
    }
    if (!composer.subject.trim() && !composer.body.trim()) {
      setComposeError("Write a subject or a message.");
      return;
    }
    const id = `m-${Date.now().toString(36)}`;
    remember("Saved in this browser. Not sent.");
    if (composer.draftId) remove(composer.draftId);
    const delivery = planDelivery([...to, ...cc]);
    const sent = {
      id,
      threadId: composer.threadId ?? id,
      folder: "sent" as const,
      from: { name: ME.name, email: ME.email },
      to,
      cc,
      subject: composer.subject.trim() || "(no subject)",
      body: composer.body,
      at: new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [audienceLabel([...to, ...cc])],
      attachments: composer.attachments,
      delivery,
    };
    sent.body = withSignature(composer.body, signature);
    saveMessage(sent);
    const mine = ME.email.toLowerCase();
    if ([...to, ...cc].some((person) => person.email.toLowerCase() === mine)) {
      saveMessage(applyRules({ ...sent, id: `${id}-in`, folder: "inbox", unread: true }, rules));
    }
    setComposer(null);
    setComposeError("");
    setBox("sent");
    setView("mail");
    setSelectedId(id);
  }

  function saveDraft() {
    if (!composer) return;
    const id = composer.draftId ?? `d-${Date.now().toString(36)}`;
    saveMessage({
      id,
      threadId: composer.threadId ?? id,
      folder: "drafts",
      from: { name: ME.name, email: ME.email },
      to: parsePeople(composer.to),
      cc: parsePeople(composer.cc),
      subject: composer.subject.trim() || "(no subject)",
      body: composer.body,
      at: new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [],
      attachments: composer.attachments,
    });
    setComposer(null);
    setComposeError("");
    setBox("drafts");
    setView("mail");
    setSelectedId(null);
  }

  async function assist() {
    if (!composer || assisting) return;
    setAssisting(true);
    setComposeError("");
    try {
      const related = composer.threadId ? threadOf(messages, composer.threadId) : [];
      const source =
        related.length > 0
          ? transcript(related)
          : composer.body.trim() || `New message. Subject: ${composer.subject || "(none)"}.`;
      const result = await briefThread({
        data: { mode: "draft", subject: composer.subject, transcript: source },
      });
      if (!result.ok) {
        setComposeError(result.error);
        return;
      }
      const marker = "\n\n—\n";
      const cut = composer.body.indexOf(marker);
      const quoted = cut >= 0 ? composer.body.slice(cut) : "";
      setComposer({ ...composer, body: `${result.text}${quoted}` });
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : "SCALVS could not draft this.");
    } finally {
      setAssisting(false);
    }
  }

  async function runBrief() {
    if (!reading || briefing) return;
    const items = thread.length ? thread : [reading];
    setBriefing(true);
    setBriefError("");
    try {
      const result = await briefThread({
        data: { mode: "summary", subject: reading.subject, transcript: transcript(items) },
      });
      if (!result.ok) setBriefError(result.error);
      else saveBrief(briefKey(items), result.text);
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : "SCALVS could not brief this thread.");
    } finally {
      setBriefing(false);
    }
  }

  function handOff() {
    if (!reading) return;
    if (tasks.some((task) => task.messageId === reading.id)) {
      setNotice("Architect already has this.");
      setView("tasks");
      return;
    }
    addTask({
      id: `t-${Date.now().toString(36)}`,
      title: reading.subject,
      detail: "Queued from mail · waiting on you",
      done: false,
      messageId: reading.id,
    });
    setNotice("Handed to Architect. It will not send the mail.");
  }

  function moveSelected(id: string, folder: "archive" | "trash" | "inbox") {
    const message = messages.find((item) => item.id === id);
    const threadId = message?.threadId ?? id;
    if (folder === "archive") {
      remember("Archived.");
      replaceMessages(archiveThreads(messages, [threadId]));
    } else if (folder === "trash") {
      remember("Moved to Trash.");
      replaceMessages(trashThreads(messages, [threadId]));
    } else {
      remember("Moved to Inbox.");
      move(id, folder);
    }
    if (selectedId === id) setSelectedId(null);
    setPicked([]);
  }

  function actOnPicked(kind: "archive" | "trash" | "unread") {
    if (!picked.length) return;
    const count = picked.length;
    if (kind === "archive") {
      remember(count === 1 ? "Conversation archived." : `${count} conversations archived.`);
      replaceMessages(archiveThreads(messages, picked));
    } else if (kind === "trash") {
      remember(count === 1 ? "Conversation moved to Trash." : `${count} conversations moved to Trash.`);
      replaceMessages(trashThreads(messages, picked));
    } else {
      remember(count === 1 ? "Marked as unread." : `${count} conversations marked as unread.`);
      replaceMessages(picked.reduce((next, threadId) => markThreadUnread(next, threadId), messages));
    }
    setPicked([]);
    setSelectedId(null);
  }

  return (
    <div className="mail-shell">
      <p className="border-b border-line px-3 py-2 font-mono text-xs text-muted md:px-5" role="status">
        Local demo. Messages stay in this browser. Nothing is sent, encrypted, or stored with Drive.
      </p>
      <header className="flex flex-col gap-3 border-b border-line px-3 py-3 md:flex-row md:items-center md:gap-5 md:px-5">
        <div className="flex items-center gap-2">
          <button type="button" className="grid size-11 place-items-center md:hidden" onClick={() => setNavOpen(true)} aria-label="Open folders">
            <Menu className="size-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-xl tracking-tight">
              Cumulus<span className="font-mono text-accent">://</span>Mail
            </p>
            <p className="truncate font-mono text-xs text-muted">{ME.email}</p>
          </div>
        </div>
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 border border-line px-3 md:max-w-xl">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === "contacts" ? "Search people" : "Search mail"}
            title="from: leah · to: priya · subject: forecast · is:unread · has:file"
            aria-label={view === "contacts" ? "Search people" : "Search mail"}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </label>
        <button
          type="button"
          onClick={() => writeNew()}
          className="inline-flex h-11 items-center justify-center gap-2 bg-ink px-4 text-sm text-paper transition-colors hover:bg-accent"
        >
          <SquarePen className="size-4" />
          Compose
        </button>
      </header>
      <div className="mail-body">
        <Sidebar
          open={navOpen}
          view={view}
          box={box}
          messages={messages}
          openTasks={openTasks}
          onClose={() => setNavOpen(false)}
          onView={(next) => {
            setView(next);
            setNavOpen(false);
          }}
          onBox={(next) => {
            setBox(next);
            setView("mail");
            setSelectedId(null);
            setPicked([]);
            setNavOpen(false);
          }}
          onAccount={() => {
            setAccountOpen(true);
            setNavOpen(false);
          }}
        />
        {view === "mail" ? (
          <>
            <MessageList
              box={box}
              rows={rows}
              messages={messages}
              selectedId={reading?.id ?? null}
              unreadOnly={unreadOnly}
              picked={picked}
              onUnreadOnly={setUnreadOnly}
              onOpen={openRow}
              onStar={toggleStar}
              onTogglePick={(threadId) => setPicked((current) => (current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId]))}
              onPickAll={(threadIds, on) => setPicked(on ? threadIds : [])}
              onArchivePicked={() => actOnPicked("archive")}
              onTrashPicked={() => actOnPicked("trash")}
              onUnreadPicked={() => actOnPicked("unread")}
              onClearPick={() => setPicked([])}
              onEmptyTrash={() => {
                if (!messages.some((message) => message.folder === "trash")) return;
                if (!window.confirm("Delete everything in Trash? This can be undone.")) return;
                remember("Trash emptied.");
                replaceMessages(emptyTrash(messages));
                setSelectedId(null);
              }}
            />
            <Reader
              message={reading}
              thread={thread}
              brief={briefText}
              briefError={briefError}
              briefing={briefing}
              notice={notice}
              composer={composer?.placement === "inline" ? composer : null}
              composeError={composeError}
              assisting={assisting}
              onBack={() => setSelectedId(null)}
              onStar={toggleStar}
              onArchive={(id) => moveSelected(id, "archive")}
              onTrash={(id) => moveSelected(id, "trash")}
              onSnooze={() => {
                if (!reading) return;
                remember("Snoozed until tomorrow morning.");
                snooze(reading.id, tomorrowMorning());
                setSelectedId(null);
              }}
              onUnread={() => {
                if (!reading) return;
                remember("Marked as unread.");
                replaceMessages(markThreadUnread(messages, reading.threadId));
                setSelectedId(null);
              }}
              onMute={() => {
                if (!reading || reading.from.email === ME.email) return;
                if (!rules.some((rule) => rule.action === "archive" && rule.from.toLowerCase() === reading.from.email.toLowerCase())) {
                  remember(`Mail from ${reading.from.name} will be archived.`);
                  addRule({ id: `r-${Date.now().toString(36)}`, from: reading.from.email, action: "archive" });
                } else {
                  remember("Muted.");
                }
                replaceMessages(archiveThreads(messages, [reading.threadId]));
                setSelectedId(null);
              }}
              onRestore={(id) => moveSelected(id, "inbox")}
              onRemove={(id) => {
                remember("Deleted.");
                remove(id);
                setSelectedId(null);
              }}
              onReply={reply}
              onReplyAll={replyAll}
              onForward={forward}
              onBrief={() => void runBrief()}
              onTask={handOff}
              onChange={setComposer}
              onSend={send}
              onSave={saveDraft}
              onCloseComposer={() => setComposer(null)}
              onAssist={() => void assist()}
              knownContact={!reading || reading.from.email === ME.email || contacts.some((c) => c.email === reading.from.email)}
              onSaveContact={() => {
                if (!reading || reading.from.email === ME.email) return;
                addContact({
                  id: `c-${Date.now().toString(36)}`,
                  name: reading.from.name,
                  email: reading.from.email,
                  org: usesSampleMailDomain(reading.from.email) ? "Cumulus://Mail" : "External",
                  note: "Saved from a message.",
                });
              }}
            />
          </>
        ) : null}
        {view === "calendar" ? (
          <CalendarPanel events={EVENTS.filter((event) => !query.trim() || `${event.title} ${event.with} ${event.where}`.toLowerCase().includes(query.trim().toLowerCase()))} />
        ) : null}
        {view === "contacts" ? (
          <ContactsPanel contacts={contacts} query={query} onWrite={(contact) => writeNew(peopleToField([contact]))} />
        ) : null}
        {view === "tasks" ? <TasksPanel tasks={tasks} onToggle={toggleTask} /> : null}
      </div>
      {modal ? (
        <div className="scrim fixed inset-0 z-40 flex items-end md:items-center md:justify-center md:p-6" role="presentation">
          <div className="flex max-h-dvh w-full flex-col bg-paper md:max-w-2xl md:border md:border-line" role="dialog" aria-label="Compose">
            <Composer
              form={modal}
              error={composeError}
              assisting={assisting}
              onChange={setComposer}
              onSend={send}
              onSave={saveDraft}
              onClose={() => setComposer(null)}
              onAssist={() => void assist()}
            />
          </div>
        </div>
      ) : null}
      {accountOpen ? (
        <AccountPanel
          aliases={aliases}
          quotaLabel={quota(messages).label}
          signature={signature}
          rules={rules}
          onClose={() => setAccountOpen(false)}
          onAddAlias={addAlias}
          onSignature={setSignature}
          onAddRule={addRule}
          onRemoveRule={removeRule}
        />
      ) : null}
      {undo ? (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 border border-line bg-paper px-4 py-3" role="status">
          <p className="text-sm">{undo.label}</p>
          <button type="button" className="text-sm text-accent" onClick={undoLast}>
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}
