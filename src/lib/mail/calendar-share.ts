import type { CalEvent, MailMessage } from "./model.ts";

/** An iTIP REQUEST the owner can send. The event details are the body. Delivery seals it when the recipient has a key. */
export function shareRequest(event: CalEvent, from: { name: string; email: string }, toEmail: string, id: string): MailMessage {
  const uid = event.uid || event.id;
  const body = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Cumulus//Mail//EN",
    "METHOD:REQUEST",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${event.sort.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
    `SUMMARY:${event.title.replace(/[\r\n]/g, " ")}`,
    `ORGANIZER:mailto:${from.email}`,
    `ATTENDEE:mailto:${toEmail}`,
    event.where ? `LOCATION:${event.where.replace(/[\r\n]/g, " ")}` : "",
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
