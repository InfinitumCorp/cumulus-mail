import { validEmail } from "./logic.ts";
import type { CalEvent, MailMessage } from "./model.ts";

/** An iCalendar TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks escaped. */
export function icalText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** The address to share with, or null. The invitation is delivered as soon as it is saved in Sent. */
export function shareAddress(value: string): string | null {
  const email = value.trim().toLowerCase();
  return validEmail(email) && email.length <= 254 ? email : null;
}

/** An iTIP REQUEST the owner can send. The event details are the body. Delivery seals it when the recipient has a key. */
export function shareRequest(event: CalEvent, from: { name: string; email: string }, to: string, id: string): MailMessage {
  const toEmail = shareAddress(to);
  if (!toEmail) throw new Error("Enter an email address to share with.");
  const uid = (event.uid || event.id).replace(/[\r\n]/g, "");
  const body = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Cumulus//Mail//EN",
    "METHOD:REQUEST",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${event.sort.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
    `SUMMARY:${icalText(event.title)}`,
    `ORGANIZER:mailto:${from.email}`,
    `ATTENDEE:mailto:${toEmail}`,
    event.where ? `LOCATION:${icalText(event.where)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
  return {
    id,
    threadId: id,
    folder: "sent",
    from,
    to: [{ name: toEmail, email: toEmail }],
    cc: [],
    subject: `Invitation: ${event.title}`.slice(0, 200),
    body,
    at: new Date().toISOString(),
    unread: false,
    starred: false,
    labels: [],
  };
}
