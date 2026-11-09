import { create } from "zustand";
import { getMailbox, putMailbox } from "@/lib/mail/api";
import {
  ME,
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
  snooze: (id: string, until: string) => void;
  setSignature: (signature: string) => void;
  addRule: (rule: MailRule) => void;
  removeRule: (id: string) => void;
  replaceMessages: (messages: MailMessage[]) => void;
  replaceRules: (rules: MailRule[]) => void;
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
  };
}

let dirty = false;
let revision = 0;
let hydratePromise: Promise<void> | null = null;
let pushChain: Promise<void> = Promise.resolve();

function schedulePush(get: () => MailStore, set: (partial: Partial<MailStore>) => void) {
  if (typeof window === "undefined") return;
  const mine = ++revision;
  const snapshot = pick(get());
  pushChain = pushChain
    .catch(() => undefined)
    .then(async () => {
      const saved = await putMailbox({ data: snapshot });
      if (mine !== revision) return;
      set({ ...saved, syncError: "" });
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
        if (!dirty) set({ ...saved, syncError: "" });
      } catch (error) {
        set({ syncError: error instanceof Error ? error.message : "Mailbox sync failed" });
      }
    })();
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
    if (get().aliases.includes(alias) || alias === get().me.email) return;
    commit(set, get, { aliases: [...get().aliases, alias] });
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
  snooze: (id, until) => {
    commit(set, get, {
      messages: get().messages.map((message) => (message.id === id ? { ...message, snoozeUntil: until, unread: false } : message)),
    });
  },
  setSignature: (signature) => {
    commit(set, get, { signature });
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
}));
