import { create } from "zustand";
import { getMailbox, putMailbox } from "@/lib/mail/api";
import {
  ME,
  MAX_ALIASES,
  SEED_CONTACTS,
  SEED_MESSAGES,
  SEED_TASKS,
  type ArchitectTask,
  type Contact,
  type FolderId,
  type MailMessage,
  type MailRule,
} from "./model";
import type { MailProfile, MailboxSnapshot } from "./snapshot";
import { mailDomain } from "./domain";
import { defaultSettings, sanitizeSettings, type MailSettings } from "./settings";

type MailStore = MailboxSnapshot & {
  syncError: string;
  hydrate: () => void;
  flush: () => Promise<void>;
  markThreadRead: (threadId: string) => void;
  toggleStar: (id: string) => void;
  move: (id: string, folder: FolderId) => void;
  remove: (id: string) => void;
  saveMessage: (message: MailMessage) => void;
  addAlias: (alias: string) => void;
  saveBrief: (key: string, text: string) => void;
  addTask: (task: ArchitectTask) => void;
  toggleTask: (id: string) => void;
  addContact: (contact: Contact) => void;
  saveContact: (contact: Contact) => void;
  /** Replace the whole contact list (import). */
  replaceContacts: (contacts: Contact[]) => void;
  snooze: (id: string, until: string) => void;
  setSignature: (signature: string) => void;
  setDisplayName: (name: string) => void;
  setSettings: (settings: MailSettings) => void;
  addRule: (rule: MailRule) => void;
  removeRule: (id: string) => void;
  replaceMessages: (messages: MailMessage[]) => void;
  replaceRules: (rules: MailRule[]) => void;
  replaceSnapshot: (snapshot: MailboxSnapshot) => void;
};

const previewProfile: MailProfile = {
  name: ME.name,
  email: ME.email,
  cid: ME.cid,
  plan: ME.plan,
  quotaGb: ME.quotaGb,
};

function blank(): MailboxSnapshot {
  return {
    me: previewProfile,
    messages: SEED_MESSAGES,
    aliases: ["press@cumuluscloud.app"],
    briefs: {},
    tasks: SEED_TASKS,
    contacts: SEED_CONTACTS,
    signature: "Alex Reid\nalex@cumuluscloud.app",
    rules: [],
    settings: defaultSettings(),
  };
}

function pick(state: MailStore): MailboxSnapshot {
  return {
    me: state.me,
    messages: state.messages,
    aliases: state.aliases,
    briefs: state.briefs,
    tasks: state.tasks,
    contacts: state.contacts,
    signature: state.signature,
    rules: state.rules,
    settings: state.settings ?? defaultSettings(),
  };
}

let dirty = false;
let revision = 0;
let hydratePromise: Promise<void> | null = null;
let pushChain: Promise<void> = Promise.resolve();
let pushing = 0;
/**
 * The ids of the messages in the last snapshot the server sent. Sent with every save, so the server
 * deletes only what this tab knew about and removed, and keeps mail that arrived since (src/lib/mail/
 * mailbox.ts writeSnapshot). Empty before the first load: then nothing on the server is deleted.
 */
let knownIds: string[] = [];
/** The per-message server revs from that snapshot; sent back so the server can spot a stale copy. */
let knownRevs: Record<string, number> = {};
const remember = (snapshot: MailboxSnapshot) => {
  knownIds = snapshot.messages.map((message) => message.id);
  knownRevs = snapshot.revs ?? {};
};

/**
 * While a save is in flight, leaving the page (reload, close, typing another address) asks first, as
 * Gmail does: the save is a normal request and dies with the page, so a change made a moment before a
 * reload was lost. A full snapshot is far over the 64 KB keepalive limit, so it cannot simply be sent on
 * the way out. The listener exists only while saving: an idle page keeps the back/forward cache.
 * `<html data-saving="1|0">` says the same thing to tests.
 */
function warnWhileSaving(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function setPushing(next: number) {
  const was = pushing;
  pushing = next;
  if (typeof window === "undefined") return;
  document.documentElement.dataset.saving = pushing > 0 ? "1" : "0";
  if (was === 0 && pushing > 0) window.addEventListener("beforeunload", warnWhileSaving);
  if (was > 0 && pushing === 0) window.removeEventListener("beforeunload", warnWhileSaving);
}

function schedulePush(get: () => MailStore, set: (partial: Partial<MailStore>) => void) {
  if (typeof window === "undefined") return;
  const mine = ++revision;
  const snapshot = pick(get());
  setPushing(pushing + 1);
  pushChain = pushChain
    .catch(() => undefined)
    .then(async () => {
      const saved = await putMailbox({ data: { ...snapshot, knownIds, knownRevs } });
      remember(saved);
      if (mine !== revision) return;
      set({ ...saved, syncError: "" });
    })
    .finally(() => {
      setPushing(pushing - 1);
    })
    .catch((error: unknown) => {
      set({ syncError: error instanceof Error ? error.message : "Mailbox sync failed" });
      throw error;
    });
}

function commit(
  set: (partial: Partial<MailStore>) => void,
  get: () => MailStore,
  partial: Partial<MailboxSnapshot>,
) {
  dirty = true;
  set(partial);
  schedulePush(get, set);
}

export const useMail = create<MailStore>((set, get) => ({
  ...blank(),
  syncError: "",
  hydrate: () => {
    if (hydratePromise || typeof window === "undefined") return;
    hydratePromise = (async () => {
      try {
        const saved = await getMailbox();
        remember(saved);
        if (!dirty) set({ ...saved, syncError: "" });
      } catch (error) {
        set({ syncError: error instanceof Error ? error.message : "Mailbox sync failed" });
      }
    })();
    // New mail shows up without a click: a quiet refresh every minute and when the tab comes back, skipped
    // while a save is in flight or the tab is hidden, and dropped if the person changed something meanwhile.
    const refresh = async () => {
      if (pushing > 0 || document.visibilityState !== "visible") return;
      const before = revision;
      try {
        const saved = await getMailbox();
        if (pushing > 0 || revision !== before) return;
        remember(saved);
        set({ ...saved, syncError: "" });
      } catch {
        // offline or signed out: the next save or refresh reports it
      }
    };
    window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", () => void refresh());
  },
  flush: () => (hydratePromise ? hydratePromise.then(() => pushChain) : pushChain),
  markThreadRead: (threadId) => {
    commit(set, get, {
      messages: get().messages.map((message) => (message.threadId === threadId ? { ...message, unread: false } : message)),
    });
  },
  toggleStar: (id) => {
    commit(set, get, {
      messages: get().messages.map((message) => (message.id === id ? { ...message, starred: !message.starred } : message)),
    });
  },
  move: (id, folder) => {
    commit(set, get, {
      messages: get().messages.map((message) => (message.id === id ? { ...message, folder, unread: false } : message)),
    });
  },
  remove: (id) => {
    commit(set, get, { messages: get().messages.filter((message) => message.id !== id) });
  },
  saveMessage: (message) => {
    const exists = get().messages.some((item) => item.id === message.id);
    commit(set, get, {
      messages: exists
        ? get().messages.map((item) => (item.id === message.id ? message : item))
        : [message, ...get().messages],
    });
  },
  addAlias: (alias) => {
    const email = alias.trim().toLowerCase();
    if (!email || get().aliases.includes(email) || email === get().me.email) return;
    if (get().aliases.length >= (get().me.limits?.aliases ?? MAX_ALIASES)) return;
    commit(set, get, { aliases: [...get().aliases, email] });
  },
  saveBrief: (key, text) => {
    commit(set, get, { briefs: { ...get().briefs, [key]: text } });
  },
  addTask: (task) => {
    if (get().tasks.some((item) => item.messageId && item.messageId === task.messageId)) return;
    commit(set, get, { tasks: [task, ...get().tasks] });
  },
  toggleTask: (id) => {
    commit(set, get, {
      tasks: get().tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task)),
    });
  },
  addContact: (contact) => {
    if (get().contacts.some((item) => item.email === contact.email)) return;
    commit(set, get, { contacts: [...get().contacts, contact] });
  },
  saveContact: (contact) => {
    const contacts = get().contacts.some((item) => item.id === contact.id)
      ? get().contacts.map((item) => (item.id === contact.id ? contact : item))
      : [...get().contacts, contact];
    commit(set, get, { contacts });
  },
  replaceContacts: (contacts) => {
    commit(set, get, { contacts });
  },
  snooze: (id, until) => {
    commit(set, get, {
      messages: get().messages.map((message) => (message.id === id ? { ...message, snoozeUntil: until, unread: false } : message)),
    });
  },
  setSignature: (signature) => {
    commit(set, get, { signature });
  },
  setDisplayName: (name) => {
    const clean = name.replace(/[\r\n\t"<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    if (clean) commit(set, get, { me: { ...get().me, name: clean } });
  },
  setSettings: (settings) => {
    commit(set, get, { settings: sanitizeSettings(settings, mailDomain()) });
  },
  addRule: (rule) => {
    commit(set, get, { rules: [...get().rules, rule] });
  },
  removeRule: (id) => {
    commit(set, get, { rules: get().rules.filter((rule) => rule.id !== id) });
  },
  replaceMessages: (messages) => {
    commit(set, get, { messages });
  },
  replaceRules: (rules) => {
    commit(set, get, { rules });
  },
  replaceSnapshot: (snapshot) => {
    commit(set, get, snapshot);
  },
}));
