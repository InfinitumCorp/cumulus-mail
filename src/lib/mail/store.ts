import { create } from "zustand";
import { SAMPLE_MAIL_DOMAIN } from "./domain";
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

const KEY = "cumulus-mail-v1";

type Snapshot = {
  messages: MailMessage[];
  aliases: string[];
  briefs: Record<string, string>;
  tasks: ArchitectTask[];
  contacts: Contact[];
  signature: string;
  rules: MailRule[];
};

type MailStore = Snapshot & {
  hydrate: () => void;
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

let dirty = false;

function blank(): Snapshot {
  return {
    messages: SEED_MESSAGES,
    aliases: [`press@${SAMPLE_MAIL_DOMAIN}`],
    briefs: {},
    tasks: SEED_TASKS,
    contacts: SEED_CONTACTS,
    signature: `Alex Reid\n${ME.email}`,
    rules: [],
  };
}

function persist(state: Snapshot) {
  if (typeof window === "undefined") return;
  const snapshot: Snapshot = {
    messages: state.messages,
    aliases: state.aliases,
    briefs: state.briefs,
    tasks: state.tasks,
    contacts: state.contacts,
    signature: state.signature,
    rules: state.rules,
  };
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

function commit(
  set: (partial: Partial<MailStore>) => void,
  get: () => MailStore,
  partial: Partial<Snapshot>,
) {
  dirty = true;
  set(partial);
  persist({ ...get(), ...partial });
}

export const useMail = create<MailStore>((set, get) => ({
  ...blank(),
  hydrate: () => {
    if (dirty || typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<Snapshot>;
      if (!Array.isArray(data.messages) || data.messages.length === 0) return;
      set({
        messages: data.messages,
        aliases: Array.isArray(data.aliases) ? data.aliases : [],
        briefs: data.briefs && typeof data.briefs === "object" ? data.briefs : {},
        tasks: Array.isArray(data.tasks) ? data.tasks : SEED_TASKS,
        contacts: Array.isArray(data.contacts) && data.contacts.length > 0 ? data.contacts : SEED_CONTACTS,
        signature: typeof data.signature === "string" ? data.signature : blank().signature,
        rules: Array.isArray(data.rules) ? data.rules : [],
      });
    } catch {
      /* keep the seed mailbox */
    }
  },
  markThreadRead: (threadId) => {
    commit(set, get, {
      messages: get().messages.map((m) => (m.threadId === threadId ? { ...m, unread: false } : m)),
    });
  },
  toggleStar: (id) => {
    commit(set, get, {
      messages: get().messages.map((m) => (m.id === id ? { ...m, starred: !m.starred } : m)),
    });
  },
  move: (id, folder) => {
    commit(set, get, {
      messages: get().messages.map((m) => (m.id === id ? { ...m, folder, unread: false } : m)),
    });
  },
  remove: (id) => {
    commit(set, get, { messages: get().messages.filter((m) => m.id !== id) });
  },
  saveMessage: (message) => {
    const exists = get().messages.some((m) => m.id === message.id);
    commit(set, get, {
      messages: exists
        ? get().messages.map((m) => (m.id === message.id ? message : m))
        : [message, ...get().messages],
    });
  },
  addAlias: (alias) => {
    if (get().aliases.includes(alias) || alias === ME.email) return;
    commit(set, get, { aliases: [...get().aliases, alias] });
  },
  saveBrief: (key, text) => {
    commit(set, get, { briefs: { ...get().briefs, [key]: text } });
  },
  addTask: (task) => {
    if (get().tasks.some((t) => t.messageId && t.messageId === task.messageId)) return;
    commit(set, get, { tasks: [task, ...get().tasks] });
  },
  toggleTask: (id) => {
    commit(set, get, {
      tasks: get().tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    });
  },
  addContact: (contact) => {
    if (get().contacts.some((c) => c.email === contact.email)) return;
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
