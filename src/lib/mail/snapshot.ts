import type {
  ArchitectTask,
  Contact,
  FolderId,
  MailMessage,
  MailRule,
  Person,
} from "./model.ts";
import { TenantAccessError } from "../storage/adapter.ts";

export type MailProfile = {
  name: string;
  email: string;
  cid: string;
  plan: string;
  quotaGb: number;
};

export type MailboxSnapshot = {
  me: MailProfile;
  messages: MailMessage[];
  aliases: string[];
  briefs: Record<string, string>;
  tasks: ArchitectTask[];
  contacts: Contact[];
  signature: string;
  rules: MailRule[];
};

const FOLDERS = new Set<FolderId>(["inbox", "sent", "drafts", "archive", "trash"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/;

export function assertId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Client payloads must not carry a tenant. The session supplies it. */
export function rejectCallerTenant(input: unknown): void {
  if (!input || typeof input !== "object") return;
  if ("tenantId" in input || "tenant" in input) {
    throw new TenantAccessError("Tenant comes from the verified session");
  }
}

export function asFolder(value: unknown): FolderId {
  if (typeof value === "string" && FOLDERS.has(value as FolderId)) return value as FolderId;
  throw new Error("Invalid folder");
}

export function asPeople(value: unknown): Person[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((person): person is Person => {
      if (!person || typeof person !== "object") return false;
      const row = person as { name?: unknown; email?: unknown };
      return typeof row.name === "string" && typeof row.email === "string";
    })
    .map((person) => ({
      name: person.name.slice(0, 200),
      email: person.email.trim().slice(0, 320),
    }));
}

export function fileName(value: string): string {
  const base = value.split(/[/\\]/).pop()?.replace(/[\r\n]/g, "").trim() ?? "";
  return (base || "file").slice(0, 180);
}
