import type { MailMessage, Person } from "../model.ts";

/**
 * RFC 2047 B-encoding only when needed; keeps plain ASCII readable. Long values are split into several
 * encoded words (at most 45 bytes of UTF-8 each, never inside a character) joined by a folding space, so
 * no encoded word passes 75 characters and no header line passes the 998-character limit.
 */
export function encodeWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** A display name as a quoted string: no CR/LF, and `"` and `\` escaped (RFC 5322 quoted-pair). */
function quotedName(name: string): string {
  return `"${name.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function address(person: Person): string {
  const email = person.email.trim();
  if (/[\s<>(),;:"\\]/.test(email) || !/^[^@]+@[^@]+$/.test(email)) throw new Error("Invalid address");
  const name = person.name.replace(/[\r\n\t]+/g, " ").trim();
  if (!name || name === email) return email;
  return `${/^[\x20-\x7e]*$/.test(name) ? quotedName(name) : encodeWord(name)} <${email}>`;
}

/** Address list with one address per folded line, so many recipients cannot pass the line limit. */
function addressList(people: Person[]): string {
  return people.map(address).join(",\r\n ");
}

function wrap76(base64: string): string {
  return base64.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

export type OutgoingFile = { name: string; contentType: string; bytes: Uint8Array };

/** Raw size limit for one outgoing message, after base64. Most providers cap at 25 MB. */
export const MAX_RAW_BYTES = 24 * 1024 * 1024;

/**
 * Upper bound of the encoded size from the stored sizes alone (base64 grows by 4/3, plus line breaks
 * and headers), so oversized mail is held before any bytes are read into memory.
 */
export function estimatedRawBytes(bodyLength: number, fileSizes: number[]): number {
  const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4 * (78 / 76);
  return Math.ceil(base64(bodyLength * 4) + fileSizes.reduce((sum, size) => sum + base64(size) + 512, 0) + 4096);
}

function base64Body(bytes: Uint8Array): string {
  return wrap76(Buffer.from(bytes).toString("base64"));
}

/** A safe Content-Type: type/subtype from the stored value, else application/octet-stream. */
function mediaType(value: string): string {
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}

/** RFC 2231 `filename*=UTF-8''…` plus a plain fallback, both free of CR/LF and quotes. */
function fileParams(name: string): { plain: string; extended: string | null } {
  const clean = name.replace(/[\r\n"\\]/g, "_").slice(0, 180) || "attachment";
  if (/^[\x20-\x7e]*$/.test(clean)) return { plain: clean, extended: null };
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { plain: ascii, extended: `UTF-8''${encoded}` };
}

/** Boundary that cannot appear in base64 or in our headers. */
function boundaryFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `=_cumulus_${hash.toString(36)}_${seed.length.toString(36)}`;
}

/**
 * Build an RFC 5322 message for SMTP: UTF-8 text/plain with a base64 body, or
 * multipart/mixed when there are attachments (each base64, with an RFC 2231
 * file name). Header values are stripped of CR/LF so nothing can be injected.
 */
export function buildRawMessage(
  message: MailMessage,
  from: Person,
  domain: string,
  now = new Date(),
  files: OutgoingFile[] = [],
): string {
  const headers = [
    `From: ${address(from)}`,
    `To: ${addressList(message.to)}`,
    ...(message.cc.length ? [`Cc: ${addressList(message.cc)}`] : []),
    `Subject: ${encodeWord(message.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${message.id.replace(/[^A-Za-z0-9._-]/g, "")}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const text = base64Body(new TextEncoder().encode(message.body));
  if (files.length === 0) {
    return `${[...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"].join("\r\n")}\r\n\r\n${text}\r\n`;
  }
  const boundary = boundaryFor(`${message.id}|${files.length}`);
  const parts = [
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", text].join("\r\n"),
    ...files.map((file) => {
      const { plain, extended } = fileParams(file.name);
      return [
        `Content-Type: ${mediaType(file.contentType)}; name="${plain}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${plain}"${extended ? `; filename*=${extended}` : ""}`,
        "",
        base64Body(file.bytes),
      ].join("\r\n");
    }),
  ];
  return [
    [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join("\r\n"),
    "",
    "This is a multi-part message in MIME format.",
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
