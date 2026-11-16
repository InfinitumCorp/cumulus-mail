/**
 * Contacts in and out: vCard (2.1, 3.0 and 4.0) and CSV (Google Contacts, Outlook, or plain
 * name/email columns) in; vCard 4.0 out. Runs in the browser — contacts are part of the mailbox
 * snapshot, so nothing new reaches the server — and has no dependencies.
 *
 * Import never overwrites what the person already has: a contact with an email already in the list
 * only gets the fields that were empty. Rows without an email are skipped (a mail contact needs one),
 * and duplicates inside the file are merged first.
 */
import type { Contact } from "./model.ts";

export type ImportedContact = Omit<Contact, "id">;
export type ImportReport = { added: number; updated: number; unchanged: number; skipped: number; duplicatesInFile: number };

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const clean = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/* ================================ vCard in ================================ */

/** RFC 6350 §3.2 unfolding: a line break followed by one space or tab continues the previous line. */
function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** vCard 2.1 QUOTED-PRINTABLE lines end in "=" to continue (soft breaks), which unfolding misses. */
function joinSoftBreaks(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous !== undefined && /QUOTED-PRINTABLE/i.test(previous.split(":")[0] ?? "") && previous.endsWith("=")) {
      out[out.length - 1] = previous.slice(0, -1) + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeQuotedPrintable(value: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

/** Split on an unescaped separator, then undo vCard escapes (\n \, \; \\). */
function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1]!;
      current += next === "n" || next === "N" ? "\n" : next;
      i += 1;
    } else if (ch === separator) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

type Property = { name: string; params: Record<string, string[]>; value: string };

function parseLine(line: string): Property | null {
  // `group.NAME;PARAM=a,b;PARAM2="x":value` — the first colon outside quotes ends the name part.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  const name = rawName!.replace(/^[^.]+\./, "").toUpperCase();
  const params: Record<string, string[]> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    // vCard 2.1 allows bare types: `EMAIL;INTERNET;PREF:`.
    const key = (eq < 0 ? "TYPE" : param.slice(0, eq)).toUpperCase();
    const values = (eq < 0 ? param : param.slice(eq + 1)).replace(/"/g, "").split(",").map((v) => v.trim().toUpperCase());
    params[key] = [...(params[key] ?? []), ...values];
  }
  let value = line.slice(colon + 1);
  if ((params.ENCODING ?? []).includes("QUOTED-PRINTABLE")) value = decodeQuotedPrintable(value, (params.CHARSET ?? ["utf-8"])[0]!.toLowerCase());
  return { name, params, value };
}

const preferred = (props: Property[]) =>
  props.find((p) => (p.params.TYPE ?? []).includes("PREF") || (p.params.PREF ?? []).length > 0) ?? props[0];

export function parseVCards(text: string): ImportedContact[] {
  const contacts: ImportedContact[] = [];
  let card: Property[] | null = null;
  for (const line of joinSoftBreaks(unfold(text.replace(/^\uFEFF/, "")))) {
    if (/^BEGIN:VCARD$/i.test(line.trim())) {
      card = [];
      continue;
    }
    if (/^END:VCARD$/i.test(line.trim())) {
      if (card) {
        const one = (name: string) => card!.filter((p) => p.name === name);
        const fn = one("FN")[0]?.value;
        const n = one("N")[0]?.value;
        const fromN = n ? splitEscaped(n, ";").slice(0, 2).reverse().filter(Boolean).join(" ") : "";
        const email = preferred(one("EMAIL"))?.value.replace(/^mailto:/i, "");
        const org = one("ORG")[0] ? splitEscaped(one("ORG")[0]!.value, ";").filter(Boolean)[0] : "";
        const tel = preferred(one("TEL"))?.value.replace(/^tel:/i, "");
        const adr = one("ADR")[0] ? splitEscaped(one("ADR")[0]!.value, ";").map((p) => p.trim()).filter(Boolean).join(", ") : "";
        const note = one("NOTE")[0] ? splitEscaped(one("NOTE")[0]!.value, "\u0000").join("") : "";
        contacts.push({
          name: clean(fn ? splitEscaped(fn, "\u0000").join("") : fromN, 200),
          email: clean(email, 320).toLowerCase(),
          org: clean(org, 200),
          note: (note ?? "").trim().slice(0, 2000),
          ...(tel ? { phone: clean(tel, 64) } : {}),
          ...(adr ? { address: clean(adr, 500) } : {}),
        });
      }
      card = null;
      continue;
    }
    if (card) {
      const property = parseLine(line);
      if (property) card.push(property);
    }
  }
  return contacts;
}

/* ================================ CSV in ================================ */

/** RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes. Also `;` files. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

/** Header names Google Contacts, Outlook and hand-made files use, lower-cased. First match wins. */
const COLUMNS = {
  name: ["name", "full name", "display name", "fn"],
  first: ["first name", "given name"],
  last: ["last name", "family name", "surname"],
  email: ["e-mail 1 - value", "email 1 - value", "e-mail address", "email address", "email", "e-mail", "primary email"],
  org: ["organization 1 - name", "organization name", "company", "organization", "org"],
  phone: ["phone 1 - value", "mobile phone", "business phone", "home phone", "phone", "telephone"],
  address: ["address 1 - formatted", "home address", "business address", "address"],
  note: ["notes", "note"],
} as const;

export function parseContactsCsv(text: string): ImportedContact[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const names = header.map((cell) => cell.trim().toLowerCase());
  const column = (key: keyof typeof COLUMNS) => {
    for (const candidate of COLUMNS[key]) {
      const at = names.indexOf(candidate);
      if (at >= 0) return at;
    }
    return -1;
  };
  const at = Object.fromEntries((Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).map((key) => [key, column(key)])) as Record<keyof typeof COLUMNS, number>;
  const get = (row: string[], index: number) => (index >= 0 ? (row[index] ?? "").trim() : "");
  return rows.map((row) => {
    const name = get(row, at.name) || [get(row, at.first), get(row, at.last)].filter(Boolean).join(" ");
    // Google puts several addresses in one cell: "a@x.com ::: b@y.com". The first is the primary.
    const email = get(row, at.email).split(/\s*:::\s*/)[0] ?? "";
    const phone = (get(row, at.phone).split(/\s*:::\s*/)[0] ?? "").trim();
    const address = get(row, at.address).replace(/\s*\n\s*/g, ", ");
    return {
      name: clean(name, 200),
      email: clean(email, 320).toLowerCase(),
      org: clean(get(row, at.org), 200),
      note: get(row, at.note).slice(0, 2000),
      ...(phone ? { phone: clean(phone, 64) } : {}),
      ...(address ? { address: clean(address, 500) } : {}),
    };
  });
}

/** vCard or CSV, from the file's name and content. */
export function parseContactsFile(name: string, text: string): ImportedContact[] {
  if (/\.vcf$|\.vcard$/i.test(name) || /^\uFEFF?\s*BEGIN:VCARD/i.test(text)) return parseVCards(text);
  return parseContactsCsv(text);
}

/* ================================ merge ================================ */

/**
 * Merge imported contacts into the list. Keyed by email. Never overwrites a field the person already
 * has; fills only empty ones. `newId` makes ids for added contacts.
 */
export function mergeContacts(
  existing: Contact[],
  incoming: ImportedContact[],
  newId: () => string,
): { contacts: Contact[]; report: ImportReport } {
  const report: ImportReport = { added: 0, updated: 0, unchanged: 0, skipped: 0, duplicatesInFile: 0 };
  // Collapse duplicates inside the file first: later rows fill the gaps of earlier ones.
  const byEmail = new Map<string, ImportedContact>();
  for (const contact of incoming) {
    if (!EMAIL.test(contact.email)) {
      report.skipped += 1;
      continue;
    }
    const seen = byEmail.get(contact.email);
    if (seen) {
      report.duplicatesInFile += 1;
      byEmail.set(contact.email, fillGaps(seen, contact));
    } else {
      byEmail.set(contact.email, contact);
    }
  }
  const contacts = [...existing];
  const index = new Map(contacts.map((contact, i) => [contact.email.trim().toLowerCase(), i]));
  for (const [email, contact] of byEmail) {
    const at = index.get(email);
    if (at === undefined) {
      contacts.push({ id: newId(), ...contact, name: contact.name || email.split("@")[0]! });
      index.set(email, contacts.length - 1);
      report.added += 1;
    } else {
      const merged = fillGaps(contacts[at]!, contact);
      if (JSON.stringify(merged) === JSON.stringify(contacts[at])) report.unchanged += 1;
      else {
        contacts[at] = merged;
        report.updated += 1;
      }
    }
  }
  return { contacts, report };
}

function fillGaps<T extends ImportedContact>(base: T, extra: ImportedContact): T {
  const out = { ...base };
  for (const key of ["name", "org", "note", "phone", "address"] as const) {
    if (!out[key]?.trim() && extra[key]?.trim()) (out as Record<string, string>)[key] = extra[key]!;
  }
  return out;
}

/* ================================ vCard out ================================ */

const escapeValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

/** RFC 6350 §3.2: lines of at most 75 octets, continued with CRLF + space, never splitting a character. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function toVCards(contacts: Contact[]): string {
  return contacts
    .map((contact) => {
      const lines = [
        "BEGIN:VCARD",
        "VERSION:4.0",
        `FN:${escapeValue(contact.name || contact.email)}`,
        `EMAIL;TYPE=work:${escapeValue(contact.email)}`,
        contact.org ? `ORG:${escapeValue(contact.org)}` : null,
        contact.phone ? `TEL;VALUE=uri:tel:${contact.phone.replace(/[^\d+]/g, "")}` : null,
        contact.address ? `ADR:;;${escapeValue(contact.address)};;;;` : null,
        contact.note ? `NOTE:${escapeValue(contact.note)}` : null,
        `UID:urn:uuid:${uuidFor(contact.id)}`,
        "END:VCARD",
      ].filter((line): line is string => line !== null);
      return lines.map(foldLine).join("\r\n");
    })
    .join("\r\n") + (contacts.length ? "\r\n" : "");
}

/** A stable UUID-shaped id from the contact id, so a re-export updates rather than duplicates. */
function uuidFor(id: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of id) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = Math.imul(h2 + ch.charCodeAt(0), 2654435761) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
