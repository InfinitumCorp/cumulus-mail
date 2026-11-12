import type { CustomFolder, CustomFolderId, FolderId, MailMessage, SystemFolderId } from "./model.ts";

export const MAX_FOLDERS = 50;
export const MAX_FOLDER_NAME = 60;

export const SYSTEM_FOLDERS: readonly SystemFolderId[] = ["inbox", "sent", "drafts", "archive", "trash", "quarantine"];

const CUSTOM_ID = /^folder-[a-z0-9]{1,40}$/;

export function isCustomFolderId(value: unknown): value is CustomFolderId {
  return typeof value === "string" && CUSTOM_ID.test(value);
}

export function isSystemFolderId(value: unknown): value is SystemFolderId {
  return typeof value === "string" && (SYSTEM_FOLDERS as readonly string[]).includes(value);
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t"]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FOLDER_NAME) : "";
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A system folder name ("Inbox", "Spam", …) can't be reused for a custom folder. */
function reserved(name: string): boolean {
  const lower = name.toLowerCase();
  return (SYSTEM_FOLDERS as readonly string[]).includes(lower) || ["spam", "starred", "snoozed", "outbox"].includes(lower);
}

/** Keep well-formed folders with unique ids and names, in order, up to the cap. */
export function sanitizeFolders(value: unknown): CustomFolder[] {
  if (!Array.isArray(value)) return [];
  const out: CustomFolder[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const { id, name } = row as { id?: unknown; name?: unknown };
    const clean = cleanName(name);
    if (!isCustomFolderId(id) || !clean || reserved(clean)) continue;
    if (out.some((folder) => folder.id === id || sameName(folder.name, clean))) continue;
    out.push({ id, name: clean });
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

export function newFolderId(random: () => string = () => Math.random().toString(36).slice(2, 10)): CustomFolderId {
  const suffix = `${Date.now().toString(36)}${random()}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  return `folder-${suffix || "x"}`;
}

/** Returns an error message, or null when the name can be used. */
export function folderNameError(folders: CustomFolder[], name: string, exceptId?: CustomFolderId): string | null {
  const clean = cleanName(name);
  if (!clean) return "Enter a folder name.";
  if (reserved(clean)) return "That name belongs to a system folder.";
  if (folders.some((folder) => folder.id !== exceptId && sameName(folder.name, clean))) return "A folder with that name exists.";
  return null;
}

export function createFolder(
  folders: CustomFolder[],
  name: string,
  id: CustomFolderId = newFolderId(),
): { folders: CustomFolder[]; folder: CustomFolder } {
  const error = folderNameError(folders, name);
  if (error) throw new Error(error);
  if (folders.length >= MAX_FOLDERS) throw new Error(`You can have up to ${MAX_FOLDERS} folders.`);
  if (folders.some((folder) => folder.id === id)) throw new Error("Folder id is taken.");
  const folder: CustomFolder = { id, name: cleanName(name) };
  return { folders: [...folders, folder], folder };
}

export function renameFolder(folders: CustomFolder[], id: CustomFolderId, name: string): CustomFolder[] {
  if (!folders.some((folder) => folder.id === id)) throw new Error("That folder no longer exists.");
  const error = folderNameError(folders, name, id);
  if (error) throw new Error(error);
  return folders.map((folder) => (folder.id === id ? { ...folder, name: cleanName(name) } : folder));
}

/** Delete a folder. Its messages go back to the Inbox; nothing is deleted. */
export function deleteFolder(
  folders: CustomFolder[],
  messages: MailMessage[],
  id: CustomFolderId,
): { folders: CustomFolder[]; messages: MailMessage[]; moved: number } {
  const nextFolders = folders.filter((folder) => folder.id !== id);
  let moved = 0;
  const nextMessages = messages.map((message) => {
    if (message.folder !== id) return message;
    moved += 1;
    return { ...message, folder: "inbox" as const };
  });
  return { folders: nextFolders, messages: moved ? nextMessages : messages, moved };
}

/** Messages filed in a folder that no longer exists go back to the Inbox. */
export function reconcileFolders(messages: MailMessage[], folders: CustomFolder[]): MailMessage[] {
  const known = new Set<string>(folders.map((folder) => folder.id));
  let changed = false;
  const next = messages.map((message) => {
    if (!isCustomFolderId(message.folder) || known.has(message.folder)) return message;
    changed = true;
    return { ...message, folder: "inbox" as const };
  });
  return changed ? next : messages;
}

export function folderByName(folders: CustomFolder[], name: string): CustomFolder | undefined {
  const clean = cleanName(name);
  return folders.find((folder) => sameName(folder.name, clean));
}

export function folderLabel(folders: CustomFolder[], id: FolderId): string {
  if (isCustomFolderId(id)) return folders.find((folder) => folder.id === id)?.name ?? "Folder";
  return id === "quarantine" ? "Quarantine" : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Move whole threads into a folder. Drafts and Sent stay put: Sent and the
 * Outbox are read from the `sent` folder, so a sent copy keeps its place.
 */
export function moveThreads(messages: MailMessage[], threadIds: string[], folder: FolderId): MailMessage[] {
  const ids = new Set(threadIds);
  let changed = false;
  const next = messages.map((message) => {
    if (!ids.has(message.threadId) || message.folder === "drafts" || message.folder === "sent" || message.folder === folder) {
      return message;
    }
    changed = true;
    return { ...message, folder };
  });
  return changed ? next : messages;
}
