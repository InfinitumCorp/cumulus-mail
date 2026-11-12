import type { MailMessage, Person } from "../model.ts";

function encodeWord(value: string): string {
  // RFC 2047 B-encoding only when needed; keeps plain ASCII readable.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function address(person: Person): string {
  const email = person.email.trim();
  if (/[\r\n<>]/.test(email)) throw new Error("Invalid address");
  const name = person.name.replace(/[\r\n"]/g, " ").trim();
  return name && name !== email ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeWord(name)} <${email}>` : email;
}

function wrap76(base64: string): string {
  return base64.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

/**
 * Build an RFC 5322 text/plain message (UTF-8, base64 body) for SMTP.
 * Attachments are not encoded here yet; callers hold mail that has them.
 */
export function buildRawMessage(message: MailMessage, from: Person, domain: string, now = new Date()): string {
  const headers = [
    `From: ${address(from)}`,
    `To: ${message.to.map(address).join(", ")}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(address).join(", ")}`] : []),
    `Subject: ${encodeWord(message.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${message.id.replace(/[^A-Za-z0-9._-]/g, "")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrap76(Buffer.from(message.body, "utf8").toString("base64"))}\r\n`;
}
