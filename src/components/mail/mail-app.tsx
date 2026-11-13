import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "@/lib/a11y/focus";
import { Menu, Search, SquarePen } from "lucide-react";
import { exportMailboxBackup, getAttachment, importMailboxBackup, submitAbuseReport, checkCustomDomain, unsubscribeList } from "@/lib/mail/api";
import { categorize, subscriptions as listSubscriptions, type Subscription } from "@/lib/mail/categories";
import { base64ToBytes } from "@/lib/mail/bytes";
import { briefThread } from "@/lib/mail/brief";
import { startConjure, followConjure } from "@/lib/mail/conjure";
import { askScalvs } from "@/lib/mail/scalvs";
import { mentionIn } from "@/lib/mail/mentions";
import {
  briefKey,
  audienceLabel,
  isCumulus,
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
  archiveThreads,
  emptyTrash,
  markThreadUnread,
} from "@/lib/mail/logic";
import { EVENTS, type Attachment, type BoxId, type CustomFolderId, type FolderId, type MailMessage, type MailRule, type MessageExtra, type ViewId } from "@/lib/mail/model";
import { createFolder, deleteFolder, folderLabel, folderNameError, moveThreads, renameFolder } from "@/lib/mail/folders";
import { buildReply, parseInvite } from "@/lib/mail/invite";
import { expandEvents, withRsvp } from "@/lib/mail/calendar";
import { decryptWith, encryptFor, generateMailKey, isArmored } from "@/lib/mail/openpgp";
import { openWithPassword, PROTECTED_PLACEHOLDER, sealWithPassword, spendRead } from "@/lib/mail/protect";
import { releaseDue } from "@/lib/mail/schedule";
import { assessPhishing, classifyLink, extractLinks, stripRemoteImages } from "@/lib/mail/safety";
import type { MailboxBackup } from "@/lib/mail/backup";
import { defaultSettings, noteUnsubscribed, recordAudit } from "@/lib/mail/settings";
import { useMail } from "@/lib/mail/store";
import { Composer, type DraftForm } from "./composer";
import { MessageList, type InboxTab } from "./message-list";
import { AccountPanel, CalendarPanel, ContactsPanel, TasksPanel } from "./panels";
import { Reader } from "./reader";
import { Sidebar } from "./sidebar";

function localInput(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  const me = useMail((s) => s.me);
  const syncError = useMail((s) => s.syncError);
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
  const setSettings = useMail((s) => s.setSettings);
  const settings = useMail((s) => s.settings);
  const saveContact = useMail((s) => s.saveContact);
  const replaceContacts = useMail((s) => s.replaceContacts);
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
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [unlockError, setUnlockError] = useState("");
  const [pendingLink, setPendingLink] = useState<{ href: string; reason?: string } | null>(null);
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [pgp, setPgp] = useState<{ publicKey: string; privateKey: string; passphrase: string } | null>(null);
  const [keyError, setKeyError] = useState("");
  const [domainNote, setDomainNote] = useState("");
  const [inboxTab, setInboxTab] = useState<InboxTab>("all");
  const [unsubscribing, setUnsubscribing] = useState<string | null>(null);
  const [subscriptionNote, setSubscriptionNote] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = useMail.getState().messages;
      const released = releaseDue(current);
      if (released !== current) useMail.getState().replaceMessages(released);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

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
      } else if (event.key === "a" && reading) {
        event.preventDefault();
        replyAll();
      } else if (event.key === "f" && reading) {
        event.preventDefault();
        forward();
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
        replaceMessages(markThreadUnread(messages, reading.threadId, me.email));
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
      } else if (event.key === "?") {
        event.preventDefault();
        setHelp(true);
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if ((event.key === "o" || event.key === "Enter") && !reading && rows[0] && view === "mail") {
        if (event.key === "Enter" && target instanceof HTMLElement && target.closest("button, a")) return;
        event.preventDefault();
        openRow(rows.find((row) => row.id === selectedId) ?? rows[0]);
      } else if (event.key === "Escape" && reading && !help && !pendingLink && !modal && !accountOpen) {
        event.preventDefault();
        const id = reading.id;
        setSelectedId(null);
        // Give focus back to the row that was open, so j/k and Tab carry on from there.
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"] button`)?.focus());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!selectedId) return;
    document.querySelector(`[data-row-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const allRows = listThreads(messages, box, query, unreadOnly);
  const rows =
    box === "inbox" && inboxTab !== "all" && inboxTab !== "subscriptions"
      ? allRows.filter((row) => categorize(row) === inboxTab)
      : allRows;
  const subscriptionRows = box === "inbox" && inboxTab === "subscriptions" ? listSubscriptions(messages, me.email) : [];
  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const reading = selected && selected.folder !== "drafts" ? selected : null;
  const thread = visibleThread(messages, reading);
  const briefText = thread.length ? briefs[briefKey(thread)] ?? "" : "";
  const openTasks = tasks.filter((task) => !task.done).length;
  const modal = composer?.placement === "modal" ? composer : null;
  // Compose has no Escape-to-close: it would drop what was typed. Focus still moves in and stays.
  const composeDialog = useDialogFocus<HTMLDivElement>(Boolean(modal));
  const linkDialog = useDialogFocus<HTMLDivElement>(Boolean(pendingLink), () => setPendingLink(null));
  const helpDialog = useDialogFocus<HTMLDivElement>(help, () => setHelp(false));

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
        cloudLinks: message.extra?.cloudLinks,
        requestReceipt: message.extra?.readReceipt === "requested",
        scheduleAt: localInput(message.extra?.scheduleAt),
      });
      return;
    }
    setSelectedId(message.id);
    markThreadRead(message.threadId);
  }

  function reply() {
    if (!reading) return;
    const source = [...thread].reverse().find((message) => message.from.email !== me.email) ?? reading;
    const to = source.from.email === me.email ? source.to : [source.from];
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
    const source = [...thread].reverse().find((message) => message.from.email !== me.email) ?? reading;
    const mine = me.email.toLowerCase();
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

  async function unlockMessage(password: string) {
    if (!reading?.extra?.protection) return;
    try {
      let text = await openWithPassword(reading.extra.protection, password);
      if (pgp && isArmored(text)) text = await decryptWith(text, pgp.privateKey, pgp.passphrase);
      setOpened((current) => ({ ...current, [reading.id]: text }));
      const spent = spendRead(reading.extra.protection);
      saveMessage({
        ...reading,
        extra: spent.ciphertext ? { ...reading.extra, protection: spent } : { ...reading.extra, protection: undefined },
      });
      setUnlockError("");
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : "Could not unlock.");
    }
  }

  async function send() {
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
    let body = withSignature(composer.body, signature);
    let extra: MessageExtra | undefined = composer.cloudLinks?.length ? { cloudLinks: composer.cloudLinks } : undefined;
    const recipients = [...to, ...cc];
    const keys = recipients
      .map((person) => contacts.find((contact) => contact.email.toLowerCase() === person.email.toLowerCase())?.publicKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === recipients.length) {
      try {
        body = await encryptFor(body, keys);
        extra = { ...extra, pgp: true };
      } catch (error) {
        setComposeError(error instanceof Error ? error.message : "OpenPGP could not encrypt this.");
        return;
      }
    }
    if (composer.passwordProtected) {
      if (!composer.password || composer.password.length < 8) {
        setComposeError("Use a password of at least 8 characters.");
        return;
      }
      extra = {
        ...extra,
        protection: await sealWithPassword(body, composer.password, {
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          reads: composer.selfDestruct ? 1 : 20,
          selfDestruct: Boolean(composer.selfDestruct),
        }),
      };
      body = PROTECTED_PLACEHOLDER;
    }
    if (composer.requestReceipt) extra = { ...extra, readReceipt: "requested" };
    let folder: "sent" | "drafts" = "sent";
    if (composer.scheduleAt) {
      const at = new Date(composer.scheduleAt);
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
        setComposeError("Choose a later time.");
        return;
      }
      extra = { ...extra, scheduleAt: at.toISOString() };
      folder = "drafts";
    } else if ((settings?.undoSendSeconds ?? 10) > 0) {
      extra = { ...extra, heldUntil: new Date(Date.now() + (settings?.undoSendSeconds ?? 10) * 1000).toISOString() };
    }
    remember(folder === "drafts" ? "Scheduled." : "Message sent.");
    if (composer.draftId) remove(composer.draftId);
    const delivery = planDelivery(recipients, { password: Boolean(composer.passwordProtected) });
    const sent = {
      id,
      threadId: composer.threadId ?? id,
      folder,
      from: { name: me.name, email: me.email },
      to,
      cc,
      subject: composer.subject.trim() || "(no subject)",
      body,
      at: new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [audienceLabel(recipients)],
      attachments: composer.attachments,
      delivery,
      extra,
    };
    saveMessage(sent);
    if (settings) setSettings(recordAudit(settings, folder === "drafts" ? "schedule" : "send", sent.subject));
    try {
      await useMail.getState().flush();
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : "Could not send.");
      return;
    }
    setComposer(null);
    setComposeError("");
    setBox(folder === "drafts" ? "drafts" : "sent");
    setView("mail");
    setSelectedId(id);
  }

  async function saveDraft() {
    if (!composer) return;
    const id = composer.draftId ?? `d-${Date.now().toString(36)}`;
    saveMessage({
      id,
      threadId: composer.threadId ?? id,
      folder: "drafts",
      from: { name: me.name, email: me.email },
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
    try {
      await useMail.getState().flush();
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : "Could not save the draft.");
      return;
    }
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
      // "@conjure <question>" in the draft: run a live Conjure forecast and put it in the draft.
      const mention = mentionIn(composer.body);
      if (mention === "conjure") {
        const related = composer.threadId ? threadOf(messages, composer.threadId) : [];
        let result = await startConjure({ data: { text: composer.body, context: related.length ? transcript(related) : "" } });
        if (result.error || !result.mention) {
          setComposeError(result.error || "Write a question after @conjure.");
          return;
        }
        const show = (text: string) => setComposer((current) => (current ? { ...current, body: `${current.body.replace(/\n*\[Conjure\][\s\S]*$/, "")}\n\n[Conjure]\n${text}` } : current));
        show(result.text ?? "");
        for (let i = 0; i < 300 && result.ticket && !["done", "failed", "cancelled"].includes(result.prediction?.status ?? ""); i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const next = await followConjure({ data: { ticket: result.ticket } });
          if (next.error) break;
          result = { ...result, ...next };
          show(next.text ?? "");
        }
        return;
      }
      // "@scalvs <task>" (or "@scalus"): the SCALVS agent (on OpenClaw) answers into the draft.
      if (mention === "scalvs") {
        const related = composer.threadId ? threadOf(messages, composer.threadId) : [];
        const result = await askScalvs({ data: { text: composer.body, context: related.length ? transcript(related) : "" } });
        if (result.error || !result.mention) {
          setComposeError(result.error || "Write a task after @scalvs.");
          return;
        }
        setComposer((current) => (current ? { ...current, body: `${current.body.replace(/\n*\[SCALVS\][\s\S]*$/, "")}\n\n[SCALVS]\n${result.text ?? ""}` } : current));
        return;
      }
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

  function moveToFolder(id: string, folder: FolderId) {
    const message = messages.find((item) => item.id === id);
    const threadId = message?.threadId ?? id;
    remember(`Moved to ${folderLabel(settings?.folders ?? [], folder)}.`);
    replaceMessages(moveThreads(messages, [threadId], folder));
    if (selectedId === id) setSelectedId(null);
    setPicked([]);
  }

  function addFolder(name: string): string | null {
    const current = settings ?? defaultSettings();
    const error = folderNameError(current.folders, name);
    if (error) return error;
    try {
      const { folders, folder } = createFolder(current.folders, name);
      setSettings(recordAudit({ ...current, folders }, "folder.create", folder.name));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not create the folder.";
    }
  }

  function renameFolderTo(id: CustomFolderId, name: string): string | null {
    const current = settings ?? defaultSettings();
    try {
      const folders = renameFolder(current.folders, id, name);
      setSettings(recordAudit({ ...current, folders }, "folder.rename", name.trim()));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not rename the folder.";
    }
  }

  function removeFolder(id: CustomFolderId) {
    const current = settings ?? defaultSettings();
    const folder = current.folders.find((item) => item.id === id);
    if (!folder) return;
    const result = deleteFolder(current.folders, messages, id);
    const note = result.moved ? ` ${result.moved === 1 ? "Its message goes" : `Its ${result.moved} messages go`} back to the Inbox.` : "";
    if (!window.confirm(`Delete the folder “${folder.name}”?${note}`)) return;
    if (result.moved) replaceMessages(result.messages);
    setSettings(recordAudit({ ...current, folders: result.folders }, "folder.delete", folder.name));
    if (box === id) {
      setBox("inbox");
      setSelectedId(null);
    }
    setNotice(`Folder “${folder.name}” deleted.`);
  }

  async function unsubscribe(item: Subscription) {
    if (!item.option) return;
    setUnsubscribing(item.key);
    setSubscriptionNote("");
    const done = (method: "one-click" | "mailto" | "link", note: string) => {
      const current = useMail.getState().settings ?? defaultSettings();
      setSettings(recordAudit(noteUnsubscribed(current, item.key, method), "unsubscribe", item.email));
      setSubscriptionNote(note);
    };
    try {
      if (item.option.kind === "one-click") {
        const result = await unsubscribeList({ data: { messageId: item.messageId } });
        if (result.method === "one-click" && result.ok) {
          done("one-click", `Unsubscribed from ${item.name}.`);
        } else {
          setSubscriptionNote(
            result.method === "one-click"
              ? `${item.name} answered ${result.status}. Try again later or use the link in one of their emails.`
              : `${item.name} has no one-click unsubscribe.`,
          );
        }
      } else if (item.option.kind === "mailto") {
        const option = item.option;
        const id = `m-unsub-${Date.now().toString(36)}`;
        saveMessage({
          id,
          threadId: id,
          folder: "sent",
          from: { name: me.name, email: me.email },
          to: [{ name: option.address, email: option.address }],
          cc: [],
          subject: option.subject,
          body: option.body || "unsubscribe",
          at: new Date().toISOString(),
          unread: false,
          starred: false,
          labels: [],
          delivery: planDelivery([{ name: option.address, email: option.address }], { password: false }),
        });
        await useMail.getState().flush();
        done("mailto", `Unsubscribe request to ${option.address} is in Sent. Mail to outside addresses waits in the Outbox until outbound SMTP is turned on.`);
      } else {
        const url = item.option.url;
        if (!window.confirm(`Open ${new URL(url).hostname} to unsubscribe from ${item.name}?`)) return;
        window.open(url, "_blank", "noopener,noreferrer");
        done("link", `Opened ${new URL(url).hostname}. Finish there.`);
      }
    } catch (error) {
      setSubscriptionNote(error instanceof Error ? error.message : "Could not unsubscribe.");
    } finally {
      setUnsubscribing(null);
    }
  }

  async function answerInvite(answer: "accepted" | "tentative" | "declined") {
    if (!reading || !settings) return;
    const invite = parseInvite(reading.body);
    if (!invite) return;
    setSettings(recordAudit({ ...settings, events: withRsvp(settings.events, invite, answer) }, `invite.${answer}`, invite.title));
    const word = answer === "accepted" ? "Accepted" : answer === "tentative" ? "Tentative" : "Declined";
    if (!invite.organizer || !invite.uid || invite.organizer === me.email.toLowerCase()) {
      setNotice(`${word}. Saved in your calendar.`);
      return;
    }
    const partstat = answer === "accepted" ? "ACCEPTED" : answer === "tentative" ? "TENTATIVE" : "DECLINED";
    const id = `m-rsvp-${Date.now().toString(36)}`;
    const organizer = { name: invite.organizer, email: invite.organizer };
    saveMessage({
      id,
      threadId: reading.threadId,
      folder: "sent",
      from: { name: me.name, email: me.email },
      to: [organizer],
      cc: [],
      subject: `${word}: ${invite.title}`,
      body: `${me.name} ${answer === "tentative" ? "might attend" : answer} “${invite.title}”.\n\n${buildReply(invite, { name: me.name, email: me.email }, partstat)}`,
      at: new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [],
      delivery: planDelivery([organizer], { password: false }),
    });
    try {
      await useMail.getState().flush();
      setNotice(`${word}. Your answer went to ${invite.organizer}${isCumulus(invite.organizer) ? "." : " and waits in the Outbox until outbound SMTP is on."}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send the answer.");
    }
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
      replaceMessages(picked.reduce((next, threadId) => markThreadUnread(next, threadId, me.email), messages));
    }
    setPicked([]);
    setSelectedId(null);
  }

  function downloadBase64(name: string, contentType: string, dataBase64: string) {
    const bytes = base64ToBytes(dataBase64);
    const blob = new Blob([Uint8Array.from(bytes)], { type: contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function openAttachment(file: Attachment, messageId: string) {
    try {
      if (file.dataBase64) {
        downloadBase64(file.name, file.contentType || "application/octet-stream", file.dataBase64);
        return;
      }
      if (!file.id) return;
      const result = await getAttachment({ data: { messageId, attachmentId: file.id } });
      downloadBase64(result.name, result.contentType, result.dataBase64);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open the file.");
    }
  }

  return (
    <div className="mail-shell">
      <header className="flex flex-col gap-3 border-b border-line px-3 py-3 md:flex-row md:items-center md:gap-5 md:px-5">
        <div className="flex items-center gap-2">
          <button type="button" className="grid size-11 place-items-center md:hidden" onClick={() => setNavOpen(true)} aria-label="Open folders">
            <Menu className="size-5" />
          </button>
          <div className="min-w-0">
            {/* The wordmark is a name, not UI text: translate="no" keeps it out of the interface translator. */}
            <p className="truncate text-xl tracking-tight" translate="no">
              Cumulus<span className="font-mono text-accent">://</span>Mail
            </p>
            <p className="truncate font-mono text-xs text-muted">{me.email}</p>
          </div>
          {/* Phones: Compose sits in the title row instead of taking a full-width row. */}
          <button
            type="button"
            onClick={() => writeNew()}
            className="ml-auto grid size-11 shrink-0 place-items-center bg-ink text-paper md:hidden"
            aria-label="Compose"
          >
            <SquarePen className="size-5" />
          </button>
        </div>
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 border border-line px-3 md:max-w-xl">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (query) setQuery("");
                else event.currentTarget.blur();
              }
            }}
            placeholder={view === "contacts" ? "Search people" : "Search mail"}
            title="from: leah · to: priya · subject: forecast · label:spectre · in:inbox · is:unread · is:encrypted · has:file"
            aria-label={view === "contacts" ? "Search people" : "Search mail"}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </label>
        <button
          type="button"
          onClick={() => writeNew()}
          className="hidden h-11 items-center justify-center gap-2 bg-ink px-4 text-sm text-paper transition-colors hover:bg-accent md:inline-flex"
        >
          <SquarePen className="size-4" />
          Compose
        </button>
      </header>
      {syncError ? <p className="border-b border-line px-5 py-2 text-sm">{syncError}</p> : null}
      <div className="mail-body">
        <Sidebar
          open={navOpen}
          view={view}
          box={box}
          messages={messages}
          me={me}
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
          folders={settings?.folders ?? []}
          onCreateFolder={addFolder}
          onRenameFolder={renameFolderTo}
          onDeleteFolder={removeFolder}
        />
        {view === "mail" ? (
          <>
            <MessageList
              box={box}
              rows={rows}
              messages={messages}
              meEmail={me.email}
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
              folders={settings?.folders ?? []}
              tab={inboxTab}
              onTab={(next) => {
                setInboxTab(next);
                setPicked([]);
                setSubscriptionNote("");
              }}
              subscriptions={subscriptionRows}
              unsubscribedKeys={(settings?.unsubscribed ?? []).map((item) => item.key)}
              unsubscribing={unsubscribing}
              onUnsubscribe={(item) => void unsubscribe(item)}
              subscriptionNote={subscriptionNote}
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
                replaceMessages(markThreadUnread(messages, reading.threadId, me.email));
                setSelectedId(null);
              }}
              onMute={() => {
                if (!reading || reading.from.email === me.email) return;
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
              folders={settings?.folders ?? []}
              onMoveTo={moveToFolder}
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
              meEmail={me.email}
              onOpenAttachment={(file, messageId) => void openAttachment(file, messageId)}
              knownContact={!reading || reading.from.email === me.email || contacts.some((c) => c.email === reading.from.email)}
              onSaveContact={() => {
                if (!reading || reading.from.email === me.email) return;
                addContact({
                  id: `c-${Date.now().toString(36)}`,
                  name: reading.from.name,
                  email: reading.from.email,
                  org: isCumulus(reading.from.email) ? "Cumulus://Mail" : "External",
                  note: "Saved from a message.",
                });
              }}
              openedBody={reading ? opened[reading.id] ?? (stripRemoteImages(reading.body).blocked ? stripRemoteImages(reading.body).html : undefined) : undefined}
              unlockError={unlockError}
              onUnlock={(password) => void unlockMessage(password)}
              warnings={reading ? assessPhishing(reading).reasons : []}
              links={reading ? extractLinks(`${reading.subject}\n${reading.body}`).map((href) => ({ href, reason: classifyLink(href).reason })) : []}
              onOpenLink={(href) => {
                const check = classifyLink(href);
                if (settings?.linkConfirmation === false && !check.suspicious) {
                  window.open(href, "_blank", "noopener,noreferrer");
                  return;
                }
                setPendingLink({ href, reason: check.reason });
              }}
              invite={reading ? parseInvite(reading.body) : null}
              onAcceptInvite={() => {
                if (!reading || !settings) return;
                const invite = parseInvite(reading.body);
                if (!invite || settings.events.some((event) => event.id === invite.id)) return;
                setSettings(recordAudit({ ...settings, events: [...settings.events, invite] }, "invite", invite.title));
              }}
              inviteRsvp={(() => {
                const invite = reading ? parseInvite(reading.body) : null;
                return invite ? settings?.events.find((event) => event.id === invite.id)?.rsvp : undefined;
              })()}
              onRsvp={(answer) => void answerInvite(answer)}
              onReceipt={(accept) => {
                if (!reading) return;
                saveMessage({ ...reading, extra: { ...reading.extra, readReceipt: accept ? "accepted" : "declined" } });
                if (!accept) return;
                saveMessage({
                  id: `rcpt-${Date.now().toString(36)}`,
                  threadId: reading.threadId,
                  folder: "sent",
                  from: { name: me.name, email: me.email },
                  to: [reading.from],
                  cc: [],
                  subject: `Read: ${reading.subject}`,
                  body: `Read receipt for “${reading.subject}”.`,
                  at: new Date().toISOString(),
                  unread: false,
                  starred: false,
                  labels: ["Receipt"],
                  extra: { autoReply: true },
                });
              }}
              onReport={() => {
                if (!reading) return;
                const reasons = assessPhishing(reading).reasons.join("; ") || "Reported from the reader.";
                void submitAbuseReport({ data: { reporter: me.email, subjectAddress: reading.from.email, detail: reasons } })
                  .then(() => setNotice("Reported."))
                  .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not report."));
              }}
            />
          </>
        ) : null}
        {view === "calendar" ? (
          <CalendarPanel
            feed
            events={expandEvents([...EVENTS, ...(settings?.events ?? [])]).filter(
              (event) => !query.trim() || `${event.title} ${event.with} ${event.where}`.toLowerCase().includes(query.trim().toLowerCase()),
            )}
          />
        ) : null}
        {view === "contacts" ? (
          <ContactsPanel contacts={contacts} query={query} onWrite={(contact) => writeNew(peopleToField([contact]))} onSave={saveContact} onReplace={replaceContacts} />
        ) : null}
        {view === "tasks" ? <TasksPanel tasks={tasks} onToggle={toggleTask} /> : null}
      </div>
      {modal ? (
        <div className="scrim fixed inset-0 z-40 flex items-end md:items-center md:justify-center md:p-6" role="presentation">
          <div ref={composeDialog} className="flex h-dvh max-h-dvh w-full flex-col bg-paper md:h-auto md:max-w-2xl md:border md:border-line" role="dialog" aria-modal="true" aria-label="Compose">
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
          me={me}
          aliases={aliases}
          quotaLabel={quota(messages, me.quotaGb, me.usedBytes).label}
          usage={{ folders: (settings?.folders ?? []).length, messages: messages.length }}
          signature={signature}
          rules={rules}
          onClose={() => setAccountOpen(false)}
          onAddAlias={addAlias}
          onSignature={setSignature}
          onAddRule={addRule}
          onRemoveRule={removeRule}
          settings={settings ?? defaultSettings()}
          onSettings={setSettings}
          domainNote={domainNote}
          pgpPublic={pgp?.publicKey ?? ""}
          keyError={keyError}
          onCheckDomain={(domain) => {
            void checkCustomDomain({ data: { domain } })
              .then((result) => {
                setDomainNote(result.verified ? `${domain} is verified.` : `Publish ${result.txtName} = ${result.txtValue}`);
                if (!settings) return;
                setSettings({
                  ...settings,
                  domains: settings.domains.map((item) => (item.domain === domain ? { ...item, verified: result.verified } : item)),
                });
              })
              .catch((error: unknown) => setDomainNote(error instanceof Error ? error.message : "DNS check failed."));
          }}
          onCreateKey={(passphrase) => {
            if (passphrase.length < 8) {
              setKeyError("Use a passphrase of at least 8 characters.");
              return;
            }
            setKeyError("");
            void generateMailKey(me.name, me.email, passphrase)
              .then((generated) => setPgp({ ...generated, passphrase }))
              .catch((error: unknown) => setKeyError(error instanceof Error ? error.message : "Could not create a key."));
          }}
          onExport={() => {
            void exportMailboxBackup()
              .then((backup) => {
                const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "cumulus-mail-backup.json";
                link.click();
                URL.revokeObjectURL(url);
                if (settings) setSettings(recordAudit(settings, "export", "Mailbox backup"));
              })
              .catch((error: unknown) => setDomainNote(error instanceof Error ? error.message : "Could not export."));
          }}
          onImport={(text) => {
            void importMailboxBackup({ data: JSON.parse(text) as MailboxBackup })
              .then((snapshot) => {
                useMail.getState().replaceSnapshot(snapshot);
                setDomainNote("Backup imported.");
              })
              .catch((error: unknown) => setDomainNote(error instanceof Error ? error.message : "Could not import."));
          }}
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
      {pendingLink ? (
        <div className="scrim fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6" role="presentation" onClick={() => setPendingLink(null)}>
          <div ref={linkDialog} role="dialog" aria-modal="true" aria-labelledby="link-title" className="w-full bg-paper p-5 md:max-w-lg md:border md:border-line" onClick={(event) => event.stopPropagation()}>
            <h2 id="link-title" className="text-2xl tracking-tight">Open this link?</h2>
            <p className="mt-3 break-all font-mono text-xs">{pendingLink.href}</p>
            {pendingLink.reason ? <p className="mt-3 text-sm text-accent">{pendingLink.reason}</p> : null}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                className="inline-flex h-11 items-center bg-ink px-4 text-sm text-paper"
                onClick={() => {
                  window.open(pendingLink.href, "_blank", "noopener,noreferrer");
                  setPendingLink(null);
                }}
              >
                Open
              </button>
              <button type="button" className="inline-flex h-11 items-center border border-line px-4 text-sm" onClick={() => setPendingLink(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {help ? (
        <div className="scrim fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6" role="presentation" onClick={() => setHelp(false)}>
          <div ref={helpDialog} role="dialog" aria-modal="true" aria-labelledby="help-title" className="w-full bg-paper p-5 md:max-w-lg md:border md:border-line" onClick={(event) => event.stopPropagation()}>
            <h2 id="help-title" className="text-2xl tracking-tight">Shortcuts</h2>
            <ul className="mt-4 space-y-2 text-sm">
              <li><kbd className="font-mono">c</kbd> compose · <kbd className="font-mono">r</kbd> reply · <kbd className="font-mono">a</kbd> reply all · <kbd className="font-mono">f</kbd> forward</li>
              <li><kbd className="font-mono">e</kbd> archive · <kbd className="font-mono">#</kbd> trash</li>
              <li><kbd className="font-mono">j</kbd> next · <kbd className="font-mono">k</kbd> previous · <kbd className="font-mono">o</kbd> or <kbd className="font-mono">Enter</kbd> open · <kbd className="font-mono">Esc</kbd> back to the list</li>
              <li><kbd className="font-mono">x</kbd> select · <kbd className="font-mono">u</kbd> unread · <kbd className="font-mono">z</kbd> undo</li>
              <li><kbd className="font-mono">/</kbd> search (<kbd className="font-mono">Esc</kbd> clears, then leaves) · <kbd className="font-mono">?</kbd> this list</li>
              <li>Dialogs keep focus inside; <kbd className="font-mono">Esc</kbd> closes them.</li>
            </ul>
            <button type="button" className="mt-5 inline-flex h-11 items-center border border-line px-4 text-sm" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
