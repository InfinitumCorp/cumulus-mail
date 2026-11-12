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

function unfold(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

export function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let name = "";
  for (const line of unfold(headerText).split("\n")) {
    if (!line) continue;
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
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

function headerParam(value: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return (match?.[1] ?? match?.[2] ?? "").trim();
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
        const name = match[1]?.trim().replace(/^"|"$/g, "") || match[2].trim();
        return { name, email: match[2].trim() };
      }
      return { name: part.split("@")[0] || part, email: part };
    });
}

function decodeQuotedPrintable(value: string): string {
  const stripped = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < stripped.length; index += 1) {
    if (stripped[index] === "=" && /[0-9A-Fa-f]{2}/.test(stripped.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(stripped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(stripped.charCodeAt(index));
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBody(body: string, encoding: string | undefined, asText: boolean): { text: string; bytes: Uint8Array } {
  const transfer = (encoding ?? "7bit").toLowerCase();
  if (transfer === "base64") {
    const bytes = decodeBase64(body);
    return { text: asText ? new TextDecoder("utf-8").decode(bytes) : "", bytes };
  }
  if (transfer === "quoted-printable") {
    const text = decodeQuotedPrintable(body);
    return { text, bytes: new TextEncoder().encode(text) };
  }
  return { text: body.replace(/\r\n/g, "\n"), bytes: new TextEncoder().encode(body) };
}

function decodeWords(value: string): string {
  // RFC 2047 §6.2: whitespace between two adjacent encoded words is not part of the text.
  return value.replace(/(\?=)\s+(?==\?)/g, "$1").replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_all, _charset, encoding, data) => {
    if (String(encoding).toLowerCase() === "b") {
      return new TextDecoder("utf-8").decode(decodeBase64(String(data)));
    }
    return decodeQuotedPrintable(String(data).replace(/_/g, " "));
  });
}

function parsePart(raw: string, into: ParsedMime): void {
  const { headers, body } = splitHeaderBody(raw.replace(/^\r?\n/, ""));
  const typeHeader = headers["content-type"] ?? "text/plain";
  const type = mediaType(typeHeader);
  const encoding = headers["content-transfer-encoding"];
  const disposition = headers["content-disposition"] ?? "";
  const filename = headerParam(disposition, "filename") || headerParam(typeHeader, "name");
  if (type.startsWith("multipart/")) {
    const boundary = headerParam(typeHeader, "boundary");
    if (!boundary) return;
    const chunks = body.split(`--${boundary}`);
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed || trimmed === "--") continue;
      parsePart(chunk, into);
    }
    return;
  }
  const decoded = decodeBody(body, encoding, type.startsWith("text/"));
  if (filename || (!type.startsWith("text/") && type !== "message/delivery-status")) {
    into.attachments.push({
      name: decodeWords(filename || "attachment"),
      contentType: type,
      bytes: decoded.bytes,
    });
    return;
  }
  if (type === "text/plain" && !into.text) into.text = decoded.text.trim();
  if (type === "text/html" && !into.text) into.text = decoded.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse a MIME message. Binary parts are expected to be base64. */
export function parseMime(raw: Uint8Array | string): ParsedMime {
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8").decode(raw);
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
  const { headers, body } = splitHeaderBody(text);
  parsed.headers = headers;
  parsed.contentType = mediaType(headers["content-type"]);
  const from = parseAddressList(headers.from)[0];
  parsed.from = from ?? { name: "", email: "" };
  parsed.to = parseAddressList(headers.to);
  parsed.cc = parseAddressList(headers.cc);
  parsed.subject = decodeWords(headers.subject ?? "");
  parsePart(`Content-Type: ${headers["content-type"] ?? "text/plain"}\r\nContent-Transfer-Encoding: ${headers["content-transfer-encoding"] ?? "7bit"}\r\n\r\n${body}`, parsed);
  if (!parsed.text && parsed.contentType === "text/plain") parsed.text = body.trim();
  return parsed;
}
