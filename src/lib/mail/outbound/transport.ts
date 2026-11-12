/**
 * Provider-agnostic outbound mail. A transport takes one envelope and a raw
 * RFC 5322 message and reports, per recipient, whether it was accepted.
 */
export type OutboundEnvelope = {
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipients (RCPT TO). */
  to: string[];
  /** The full message, CRLF line endings, already DKIM-signed if signing is on. */
  raw: string;
};

export type RecipientResult =
  | { recipient: string; ok: true; detail: string }
  | { recipient: string; ok: false; permanent: boolean; status: string; detail: string };

export interface OutboundTransport {
  readonly name: string;
  send(envelope: OutboundEnvelope): Promise<RecipientResult[]>;
}

/** Dev transport: accepts everything and keeps the messages in memory. Never touches the network. */
export function createMemoryTransport(): OutboundTransport & { sent: OutboundEnvelope[] } {
  const sent: OutboundEnvelope[] = [];
  return {
    name: "memory",
    sent,
    async send(envelope) {
      sent.push(envelope);
      return envelope.to.map((recipient) => ({ recipient, ok: true as const, detail: "Accepted by the dev transport." }));
    },
  };
}

/** Map an SMTP reply code to a result. 2xx accepted, 4xx retry, 5xx permanent. */
export function resultFromReply(recipient: string, code: number, text: string): RecipientResult {
  if (code >= 200 && code < 300) return { recipient, ok: true, detail: `${code} ${text}`.trim() };
  const status = enhancedStatus(text) ?? (code >= 500 ? "5.0.0" : "4.0.0");
  return { recipient, ok: false, permanent: code >= 500, status, detail: `${code} ${text}`.trim().slice(0, 500) };
}

function enhancedStatus(text: string): string | null {
  const match = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}
