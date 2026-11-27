import { bytesToBase64 } from "./bytes.ts";
import { parseMime } from "./mime.ts";
import type { MailMessage } from "./model.ts";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** mboxrd messages. A file that is not an mbox is returned as one chunk. */
export function splitMbox(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (!text.startsWith("From ")) return [raw];
  return text
    .split(/\n(?=From )/)
    .map((part) => part.replace(/\n>From /g, "\nFrom ").trim())
    .filter((part) => part.includes("\n") || part.includes("@"));
}

async function stableId(raw: string): Promise<string> {
  const encoded = bytesOf(raw);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `imp-${hex.slice(0, 32)}`;
}

function whenOf(headers: Record<string, string>, fallback: string): string {
  const parsed = Date.parse(headers.date ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/**
 * Messages from an .eml or an mbox. Attachment bytes are kept only under 1 MB
 * so a mailbox import cannot carry a huge file in the snapshot.
 */
export async function messagesFromMailFile(raw: string, now = new Date().toISOString()): Promise<MailMessage[]> {
  const chunks = splitMbox(raw);
  const messages: MailMessage[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const parsed = parseMime(bytesOf(chunk));
    if (!parsed.from.email && !parsed.subject && !parsed.text) continue;
    const id = await stableId(chunk);
    const attachments = [];
    for (const [index, file] of parsed.attachments.entries()) {
      if (file.bytes.byteLength > 1_000_000 || attachments.length >= 8) continue;
      attachments.push({
        id: `${id}-${index}`,
        name: file.name,
        size: file.bytes.byteLength,
        contentType: file.contentType,
        dataBase64: bytesToBase64(file.bytes),
      });
    }
    messages.push({
      id,
      threadId: id,
      folder: "inbox",
      from: parsed.from.email ? parsed.from : { name: "Imported", email: "imported@localhost" },
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject || "(no subject)",
      body: parsed.text.slice(0, 1_000_000),
      at: whenOf(parsed.headers, now),
      unread: true,
      starred: false,
      labels: ["Imported"],
      headers: parsed.headers,
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return messages;
}
