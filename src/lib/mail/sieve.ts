import type { FolderId, MailMessage } from "./model.ts";

export type SieveCondition = {
  field: "from" | "subject" | "to";
  op: "contains" | "is";
  value: string;
};

export type SieveAction =
  | { type: "folder"; folder: Extract<FolderId, "inbox" | "archive" | "trash" | "quarantine"> }
  | { type: "label"; label: string }
  | { type: "star" }
  | { type: "stop" };

export type SieveRule = {
  conditions: SieveCondition[];
  actions: SieveAction[];
};

const FOLDERS = new Set(["inbox", "archive", "trash", "quarantine"]);

function stripComment(line: string): string {
  const mark = line.indexOf("#");
  return mark >= 0 ? line.slice(0, mark) : line;
}

function fieldOf(header: string): SieveCondition["field"] | null {
  const name = header.toLowerCase();
  if (name === "from" || name === "subject" || name === "to") return name;
  return null;
}

/** A small Sieve subset: one `if header|address :contains|:is` per rule, then fileinto / addflag / stop. */
export function parseSieve(source: string): SieveRule[] {
  const lines = source.split(/\r?\n/);
  const rules: SieveRule[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = stripComment(lines[index] ?? "").trim();
    index += 1;
    if (!line) continue;
    const head = line.match(/^if\s+(header|address)\s+:(contains|is)\s+"(From|Subject|To)"\s+"([^"]*)"\s*\{$/i);
    if (!head) throw new Error(`Sieve line ${index}: unsupported condition`);
    const field = fieldOf(head[3] ?? "");
    if (!field) throw new Error(`Sieve line ${index}: unsupported header`);
    const actions: SieveAction[] = [];
    let closed = false;
    while (index < lines.length) {
      const raw = stripComment(lines[index] ?? "").trim();
      index += 1;
      if (!raw) continue;
      if (raw === "}") {
        closed = true;
        break;
      }
      const fileinto = raw.match(/^fileinto\s+"([^"]+)";$/i);
      if (fileinto) {
        const target = fileinto[1] ?? "";
        if (target.toLowerCase() === "spam") {
          actions.push({ type: "folder", folder: "quarantine" });
          continue;
        }
        if (target.startsWith("label:")) {
          const label = target.slice("label:".length).trim();
          if (!label) throw new Error(`Sieve line ${index}: empty label`);
          actions.push({ type: "label", label: label.slice(0, 80) });
          continue;
        }
        if (!FOLDERS.has(target)) throw new Error(`Sieve line ${index}: unknown fileinto ${target}`);
        actions.push({ type: "folder", folder: target as "inbox" | "archive" | "trash" | "quarantine" });
        continue;
      }
      if (/^addflag\s+"\\Starred";$/i.test(raw)) {
        actions.push({ type: "star" });
        continue;
      }
      if (/^stop;$/i.test(raw)) {
        actions.push({ type: "stop" });
        continue;
      }
      throw new Error(`Sieve line ${index}: unsupported action`);
    }
    if (!closed) throw new Error(`Sieve line ${index}: missing closing brace`);
    rules.push({
      conditions: [{ field, op: (head[2] ?? "contains").toLowerCase() as "contains" | "is", value: head[4] ?? "" }],
      actions,
    });
  }
  return rules;
}

function hay(message: MailMessage, field: SieveCondition["field"]): string {
  if (field === "from") return `${message.from.name} ${message.from.email}`.toLowerCase();
  if (field === "subject") return message.subject.toLowerCase();
  return [...message.to, ...message.cc].map((person) => `${person.name} ${person.email}`).join(" ").toLowerCase();
}

function matches(message: MailMessage, condition: SieveCondition): boolean {
  const value = condition.value.toLowerCase();
  const text = hay(message, condition.field);
  if (condition.op === "is") return text.split(/\s+/).includes(value) || text === value;
  return text.includes(value);
}

export function applySieve(message: MailMessage, source: string): MailMessage {
  if (!source.trim() || message.folder !== "inbox") return message;
  let rules: SieveRule[];
  try {
    rules = parseSieve(source);
  } catch {
    return message;
  }
  let next = message;
  for (const rule of rules) {
    if (!rule.conditions.every((condition) => matches(next, condition))) continue;
    let stop = false;
    for (const action of rule.actions) {
      if (action.type === "folder") {
        next = { ...next, folder: action.folder, unread: action.folder === "inbox" ? next.unread : false };
      } else if (action.type === "label" && !next.labels.includes(action.label)) {
        next = { ...next, labels: [...next.labels, action.label] };
      } else if (action.type === "star") {
        next = { ...next, starred: true };
      } else if (action.type === "stop") {
        stop = true;
      }
    }
    if (stop) return next;
  }
  return next;
}
