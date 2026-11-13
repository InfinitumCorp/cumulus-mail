/**
 * Metric lines for alerting (docs/ops/alerts.md). One JSON line per event on stdout, like the request
 * log: Cloudflare Workers Logs / Logpush and Yandex Cloud Logging collect stdout from both copies, and
 * an alert counts lines by `metric` and fields.
 *
 * Never personal data: no addresses, subjects or message ids. A value that looks like an email address
 * is replaced with "[redacted]", so a careless field cannot leak one.
 */
export type MetricName =
  /** One per outbound recipient attempt. outcome: sent | retry | bounced; status: the SMTP enhanced status. */
  | "mail.outbound.result"
  /** Per scheduled run: queued, sending, oldestQueuedSeconds. */
  | "mail.queue.depth"
  /** One per inbound message offered. outcome: stored | duplicate | rejected | no_mailbox | other_domain | failed. */
  | "mail.inbound.result"
  /** One per inbound message authenticated: spf, dkim, dmarc results and the disposition. */
  | "mail.inbound.auth"
  /** A refused authenticated call. reason: no_session | cross_site | tenant_mismatch. */
  | "auth.failure";

export type MetricFields = Record<string, string | number | boolean | null>;

const LOOKS_LIKE_ADDRESS = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;

export function metricLine(name: MetricName, fields: MetricFields = {}, now = new Date()): Record<string, unknown> {
  const clean: MetricFields = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = typeof value === "string" && LOOKS_LIKE_ADDRESS.test(value) ? "[redacted]" : value;
  }
  const region = typeof process !== "undefined" ? process.env?.MAIL_REGION?.trim().toLowerCase() : undefined;
  return { t: now.toISOString(), metric: name, ...(region ? { region } : {}), ...clean };
}

export function metric(name: MetricName, fields: MetricFields = {}, out: (line: string) => void = console.log): void {
  try {
    out(JSON.stringify(metricLine(name, fields)));
  } catch {
    // Metrics never break the work they describe.
  }
}
