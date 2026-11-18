import type { Person } from "./model.ts";

export type MimeAttachment = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export type ParsedMime = {
  headers: Record<string, string>;
  contentType: string;
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  text: string;
  attachments: MimeAttachment[];
};

/*
 * The message is handled as a "binary string": one char per byte (latin1), so 8-bit parts keep their
 * exact bytes and each text part is decoded with its own charset (windows-1251, KOI8-R, ISO-8859-x...).
 * Header values are read as UTF-8 (RFC 6532) and then RFC 2047 encoded words are decoded.
 */

/** Byte 0x80 + i of windows-1251 and KOI8-R, for runtimes whose TextDecoder lacks them. */
const FALLBACK_TABLES: Record<string, number[]> = {
  "windows-1251": [0x402,0x403,0x201a,0x453,0x201e,0x2026,0x2020,0x2021,0x20ac,0x2030,0x409,0x2039,0x40a,0x40c,0x40b,0x40f,0x452,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x98,0x2122,0x459,0x203a,0x45a,0x45c,0x45b,0x45f,0xa0,0x40e,0x45e,0x408,0xa4,0x490,0xa6,0xa7,0x401,0xa9,0x404,0xab,0xac,0xad,0xae,0x407,0xb0,0xb1,0x406,0x456,0x491,0xb5,0xb6,0xb7,0x451,0x2116,0x454,0xbb,0x458,0x405,0x455,0x457,0x410,0x411,0x412,0x413,0x414,0x415,0x416,0x417,0x418,0x419,0x41a,0x41b,0x41c,0x41d,0x41e,0x41f,0x420,0x421,0x422,0x423,0x424,0x425,0x426,0x427,0x428,0x429,0x42a,0x42b,0x42c,0x42d,0x42e,0x42f,0x430,0x431,0x432,0x433,0x434,0x435,0x436,0x437,0x438,0x439,0x43a,0x43b,0x43c,0x43d,0x43e,0x43f,0x440,0x441,0x442,0x443,0x444,0x445,0x446,0x447,0x448,0x449,0x44a,0x44b,0x44c,0x44d,0x44e,0x44f],
  "koi8-r": [0x2500,0x2502,0x250c,0x2510,0x2514,0x2518,0x251c,0x2524,0x252c,0x2534,0x253c,0x2580,0x2584,0x2588,0x258c,0x2590,0x2591,0x2592,0x2593,0x2320,0x25a0,0x2219,0x221a,0x2248,0x2264,0x2265,0xa0,0x2321,0xb0,0xb2,0xb7,0xf7,0x2550,0x2551,0x2552,0x451,0x2553,0x2554,0x2555,0x2556,0x2557,0x2558,0x2559,0x255a,0x255b,0x255c,0x255d,0x255e,0x255f,0x2560,0x2561,0x401,0x2562,0x2563,0x2564,0x2565,0x2566,0x2567,0x2568,0x2569,0x256a,0x256b,0x256c,0xa9,0x44e,0x430,0x431,0x446,0x434,0x435,0x444,0x433,0x445,0x438,0x439,0x43a,0x43b,0x43c,0x43d,0x43e,0x43f,0x44f,0x440,0x441,0x442,0x443,0x436,0x432,0x44c,0x44b,0x437,0x448,0x44d,0x449,0x447,0x44a,0x42e,0x410,0x411,0x426,0x414,0x415,0x424,0x413,0x425,0x418,0x419,0x41a,0x41b,0x41c,0x41d,0x41e,0x41f,0x42f,0x420,0x421,0x422,0x423,0x416,0x412,0x42c,0x42b,0x417,0x428,0x42d,0x429,0x427,0x42a],
};
const ALIASES: Record<string, string> = { cp1251: "windows-1251", "x-cp1251": "windows-1251", "koi8r": "koi8-r" };

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return out;
}

/** Bytes in a charset to text. An unknown or unsupported charset falls back to UTF-8, never an error. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  const name = ALIASES[label] ?? label;
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    const table = FALLBACK_TABLES[name];
    if (table) return Array.from(bytes, (byte) => String.fromCharCode(byte < 0x80 ? byte : table[byte - 0x80]!)).join("");
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function unfold(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

export function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let name = "";
  for (const line of unfold(headerText).split("\n")) {
    if (!line) continue;
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (match?.[1]) {
      name = match[1].toLowerCase();
      headers[name] = (match[2] ?? "").trim();
    } else if (name) {
      headers[name] = `${headers[name]} ${line.trim()}`.trim();
    }
  }
  return headers;
}

function splitHeaderBody(input: string): { headers: Record<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(input);
  if (!match || match.index === undefined) return { headers: parseHeaders(input), body: "" };
  return {
    headers: parseHeaders(input.slice(0, match.index)),
    body: input.slice(match.index + match[0].length),
  };
}

/**
 * A parameter of a structured header (Content-Type, Content-Disposition), with RFC 2231: `name*=charset'lang'
 * percent-encoded`, and continuations `name*0*=...; name*1*=...` joined in order.
 */
function headerParam(value: string, name: string): string {
  const pieces: Array<{ index: number; text: string; encoded: boolean }> = [];
  const pattern = /;\s*([A-Za-z0-9_.-]+)(\*\d+)?(\*)?\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g;
  for (const match of `;${value}`.matchAll(pattern)) {
    if (match[1]!.toLowerCase() !== name.toLowerCase()) continue;
    const index = match[2] ? Number(match[2].slice(1)) : -1;
    pieces.push({ index, text: (match[4] ?? match[5] ?? "").replace(/\\(.)/g, "$1"), encoded: Boolean(match[3]) });
  }
  if (!pieces.length) return "";
  // A plain `name=` and an extended `name*=` may both be present: prefer the extended (RFC 2231) one.
  const extended = pieces.filter((piece) => piece.encoded || piece.index >= 0);
  const chosen = (extended.length ? extended : pieces.slice(0, 1)).sort((a, b) => a.index - b.index);
  let charset = "utf-8";
  let binary = "";
  chosen.forEach((piece, position) => {
    let text = piece.text;
    if (piece.encoded && position === 0) {
      const parts = /^([^']*)'[^']*'(.*)$/.exec(text);
      if (parts) {
        charset = parts[1] || "utf-8";
        text = parts[2] ?? "";
      }
    }
    binary += piece.encoded ? text.replace(/%([0-9A-Fa-f]{2})/g, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16))) : text;
  });
  const anyEncoded = chosen.some((piece) => piece.encoded);
  // Plain values may carry raw UTF-8 or RFC 2047 words (Outlook's `name="=?UTF-8?B?...?="`).
  return (anyEncoded ? decodeCharset(binaryToBytes(binary), charset) : headerText(binary)).trim();
}

function mediaType(value: string | undefined): string {
  return (value ?? "text/plain").split(";")[0]?.trim().toLowerCase() || "text/plain";
}

export function parseAddressList(value: string | undefined): Person[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*)<([^>]+)>$/.exec(part);
      if (match?.[2]) {
        const name = decodeWords(match[1]?.trim().replace(/^"|"$/g, "") ?? "").trim() || match[2].trim();
        return { name, email: match[2].trim() };
      }
      return { name: part.split("@")[0] || part, email: part };
    });
}

/** Quoted-printable to the bytes it stands for (as a binary string). */
function quotedPrintableBinary(value: string): string {
  return value.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Base64 to bytes, ignoring anything that is not base64 (line breaks, stray characters) instead of throwing. */
function decodeBase64(value: string): Uint8Array {
  let clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  clean = clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0));
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  try {
    return binaryToBytes(atob(clean));
  } catch {
    return new Uint8Array();
  }
}

function decodeBody(body: string, encoding: string | undefined, charset: string): { text: string; bytes: Uint8Array } {
  const transfer = (encoding ?? "7bit").trim().toLowerCase();
  const bytes =
    transfer === "base64"
      ? decodeBase64(body)
      : transfer === "quoted-printable"
        ? binaryToBytes(quotedPrintableBinary(body))
        : binaryToBytes(body);
  return { bytes, text: decodeCharset(bytes, charset).replace(/\r\n/g, "\n") };
}

/** RFC 2047 encoded words, each in its own charset. */
function decodeWords(value: string): string {
  // RFC 2047 §6.2: whitespace between two adjacent encoded words is not part of the text.
  return value.replace(/(\?=)\s+(?==\?)/g, "$1").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset, encoding, data) => {
    const label = String(charset).split("*")[0]!; // RFC 2231 §5 language suffix: utf-8*ru
    const bytes =
      String(encoding).toLowerCase() === "b"
        ? decodeBase64(String(data))
        : binaryToBytes(quotedPrintableBinary(String(data).replace(/_/g, " ")));
    return decodeCharset(bytes, label);
  });
}

/** A header value: raw 8-bit bytes as UTF-8 (RFC 6532), then encoded words. */
function headerText(binary: string | undefined): string {
  if (!binary) return "";
  const utf8 = /[\x80-\xff]/.test(binary) ? decodeCharset(binaryToBytes(binary), "utf-8") : binary;
  return decodeWords(utf8);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©", reg: "®", euro: "€", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Readable text from an HTML body: no head, styles or scripts; blocks become lines; entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[entity.toLowerCase()] ?? all;
    })
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parsePart(raw: string, into: ParsedMime, depth = 0): void {
  if (depth > 20) return; // a pathological nesting is not mail anyone wants read
  const { headers, body } = splitHeaderBody(raw.replace(/^\r?\n/, ""));
  const typeHeader = headers["content-type"] ?? "text/plain";
  const type = mediaType(typeHeader);
  const encoding = headers["content-transfer-encoding"];
  const disposition = headers["content-disposition"] ?? "";
  const filename = headerParam(disposition, "filename") || headerParam(typeHeader, "name");
  if (type.startsWith("multipart/")) {
    const boundary = headerParam(typeHeader, "boundary");
    if (!boundary) return;
    // Parts sit between delimiter lines; the preamble (before the first) and the epilogue (after the
    // closing `--boundary--`) are not parts.
    const delimiter = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
    const marks = [...body.matchAll(delimiter)];
    for (let index = 0; index < marks.length; index += 1) {
      const mark = marks[index]!;
      if (mark[1]) break; // closing delimiter
      const start = mark.index! + mark[0].length;
      const end = marks[index + 1]?.index ?? body.length;
      const chunk = body.slice(start, end);
      if (chunk.trim()) parsePart(chunk, into, depth + 1);
    }
    return;
  }
  const charset = headerParam(typeHeader, "charset") || "utf-8";
  const decoded = decodeBody(body, encoding, type.startsWith("text/") ? charset : "utf-8");
  if (filename || (!type.startsWith("text/") && type !== "message/delivery-status")) {
    into.attachments.push({
      name: filename || "attachment",
      contentType: type,
      bytes: decoded.bytes,
    });
    return;
  }
  if (type === "text/plain" && !into.text) into.text = decoded.text.trim();
  if (type === "text/html" && !into.text) into.text = htmlToText(decoded.text);
}

/** Parse a MIME message. Never throws: malformed parts are skipped or read as far as they go. */
export function parseMime(raw: Uint8Array | string): ParsedMime {
  const binary = typeof raw === "string" ? bytesToBinary(new TextEncoder().encode(raw)) : bytesToBinary(raw);
  const parsed: ParsedMime = {
    headers: {},
    contentType: "text/plain",
    from: { name: "", email: "" },
    to: [],
    cc: [],
    subject: "",
    text: "",
    attachments: [],
  };
  const { headers: rawHeaders, body } = splitHeaderBody(binary);
  // Header values as text (RFC 6532 UTF-8), keeping encoded words for the fields decoded below.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    headers[name] = /[\x80-\xff]/.test(value) ? decodeCharset(binaryToBytes(value), "utf-8") : value;
  }
  parsed.headers = headers;
  parsed.contentType = mediaType(headers["content-type"]);
  const from = parseAddressList(headers.from)[0];
  parsed.from = from ?? { name: "", email: "" };
  parsed.to = parseAddressList(headers.to);
  parsed.cc = parseAddressList(headers.cc);
  parsed.subject = decodeWords(headers.subject ?? "");
  try {
    parsePart(
      `Content-Type: ${rawHeaders["content-type"] ?? "text/plain"}\r\nContent-Transfer-Encoding: ${rawHeaders["content-transfer-encoding"] ?? "7bit"}\r\n\r\n${body}`,
      parsed,
    );
  } catch {
    // Read as far as it went.
  }
  if (!parsed.text && parsed.contentType === "text/plain") parsed.text = decodeCharset(binaryToBytes(body), "utf-8").trim();
  return parsed;
}
