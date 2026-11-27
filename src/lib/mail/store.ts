import { create } from "zustand";
import { getMailbox, putMailbox } from "@/lib/mail/api";
import { diffSnapshot } from "@/lib/mail/delta";
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
import { FACTOR_REQUIRED } from "../auth/factor-gate";
import { defaultSettings, sanitizeSettings, type MailSettings } from "./settings";

type MailStore = MailboxSnapshot & {
  syncError: string;
  hydrate: () => void;
  /** Fetch the mailbox now (after a second-factor unlock): `hydrate` runs once per page. */
  reload: () => Promise<void>;
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
/** The last snapshot the server sent (a load or an acknowledged save): what a closing tab diffs against. */
let savedSnapshot: MailboxSnapshot | null = null;
const remember = (snapshot: MailboxSnapshot) => {
  savedSnapshot = snapshot;
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

/**
 * A save that has not answered in this long is abandoned, so a request that hangs (a stalled mobile
 * network, a proxy that never answers) cannot hold the "leave page?" prompt and every later save
 * forever. The change stays in this tab and is retried (below). Tests may shorten it through
 * `globalThis.__mailSaveTimeoutMs`.
 */
export const SAVE_TIMEOUT_MS = 60_000;
/** Shown while a change waits for a retry (a `message` key, so the i18n extractor picks it up). */
export const SAVE_RETRY = { message: "Could not save your last change yet. It is kept here and will be saved again shortly." };
/** Waits before retrying a save that timed out or never reached the server: 5 s, 15 s, 60 s, then every 2 min. */
export const SAVE_RETRY_MS = [5_000, 15_000, 60_000, 120_000];
let failedSaves = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const saveTimeoutMs = () => {
  const override = (globalThis as { __mailSaveTimeoutMs?: unknown }).__mailSaveTimeoutMs;
  return typeof override === "number" && override > 0 ? override : SAVE_TIMEOUT_MS;
};

/**
 * Only failures of the transport are retried: a timeout, or a request that never got an answer
 * (offline). A refusal from the server (a conflict, a missing second factor, a limit) comes back as
 * an error message and needs the person, not another try.
 */
export function retryableSaveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError";
}

function schedulePush(get: () => MailStore, set: (partial: Partial<MailStore>) => void) {
  if (typeof window === "undefined") return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const mine = ++revision;
  const snapshot = pick(get());
  setPushing(pushing + 1);
  pushChain = pushChain
    .catch(() => undefined)
    .then(async () => {
      const saved = await putMailbox({
        data: { ...snapshot, knownIds, knownRevs },
        signal: AbortSignal.timeout(saveTimeoutMs()),
      });
      failedSaves = 0;
      remember(saved);
      if (mine !== revision) return;
      set({ ...saved, syncError: "" });
    })
    .finally(() => {
      setPushing(pushing - 1);
    })
    .catch((error: unknown) => {
      // A newer save is already queued behind this one and carries the same state: nothing to say.
      if (retryableSaveError(error) && mine !== revision) throw error;
      const retry = retryableSaveError(error) && mine === revision;
      set({
        syncError: retry
          ? SAVE_RETRY.message
          : error instanceof Error
            ? error.message
            : "Mailbox sync failed",
      });
      if (retry) {
        // Nothing newer is queued (a newer change would carry this one): try the same state again.
        const wait = SAVE_RETRY_MS[Math.min(failedSaves, SAVE_RETRY_MS.length - 1)]!;
        failedSaves += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (mine === revision) schedulePush(get, set);
        }, wait);
      }
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === FACTOR_REQUIRED) set({ syncError: message });
      }
    };
    window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", () => void refresh());
    // The tab is going away (closed, reloaded, or left after the "leave page?" prompt) with a change the
    // server has not acknowledged: a save still on the wire, or one waiting for a retry. A full snapshot is
    // too big for a keepalive request, so send only what changed since the last acknowledged snapshot
    // (delta.ts). Nothing is sent when nothing is pending, so an idle tab keeps the back/forward cache.
    // The request must start synchronously here: a page that is unloading runs no later await, which is why
    // this is a plain route (src/routes/api/mailbox/delta.ts) and not a server function.
    window.addEventListener("pagehide", (event) => {
      // Going into the back/forward cache is not leaving: the page can come back and finish its own save.
      if (event.persisted) return;
      if (!savedSnapshot || (pushing === 0 && !retryTimer)) return;
      const delta = diffSnapshot(savedSnapshot, pick(get()), knownRevs);
      if (!delta) return;
      const headers: Record<string, string> = { "content-type": "application/json" };
      try {
        // The live preview's session rides a bearer token (src/lib/auth/client.ts BEARER_KEY), not a cookie.
        const bearer = window.sessionStorage.getItem("grok-auth.bearer-token");
        if (bearer) headers.authorization = `Bearer ${bearer}`;
      } catch {
        // No storage: the cookie carries the session.
      }
      void fetch("/api/mailbox/delta", { method: "POST", body: JSON.stringify(delta), headers, keepalive: true, credentials: "same-origin" }).catch(
        () => undefined,
      );
    });
  },
  reload: async () => {
    if (typeof window === "undefined") return;
    try {
      const saved = await getMailbox();
      remember(saved);
      if (!dirty || pushing === 0) set({ ...saved, syncError: "" });
    } catch (error) {
      set({ syncError: error instanceof Error ? error.message : "Mailbox sync failed" });
    }
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
