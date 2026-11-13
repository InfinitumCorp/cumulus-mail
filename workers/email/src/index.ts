import { resolverFromEnv, type DNSResolver } from "../../../src/lib/mail/authenticate.ts";
import type { TenantStorage } from "../../../src/lib/mail/delivery.ts";
import { ingestInboundEmail, storageEnforced, type InboundEmail } from "../../../src/lib/mail/inbound.ts";
import type { MailQuery } from "../../../src/lib/mail/query.ts";
import { releaseScheduledMail, type ReleaseReport } from "../../../src/lib/mail/release.ts";
import { outboundFromEnv, type OutboundConfig } from "../../../src/lib/mail/outbound/config.ts";
import { dialCloudflare } from "../../../src/lib/mail/outbound/cf-socket.ts";
import type { SmtpDial } from "../../../src/lib/mail/outbound/smtp.ts";
import { processOutboundQueue, type QueueReport } from "../../../src/lib/mail/outbound/queue.ts";
import { openWorkerIngest, type IngestHooks, type WorkerBindings } from "./bindings.ts";

/**
 * Cloudflare Email Routing `email()` handler for worker `cumulus-mail-inbound`.
 * This repository does not deploy it. There is no send binding.
 * When `env.ingest` is omitted, the handler builds db from `env.HYPERDRIVE`
 * and storage from the Supabase S3 settings. A missing Hyperdrive binding
 * stores nothing.
 */
export type InboundDeps = {
  db: MailQuery;
  storageFor: TenantStorage;
};

export type EmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | Uint8Array;
  /** Cloudflare Email Routing: refuse the message with an SMTP reply the sender sees as a bounce. */
  setReject?: (reason: string) => void;
};

export type EmailEnv = WorkerBindings & {
  ingest?: InboundDeps;
  /** Defaults to cumuluscloud.app. Not a secret. */
  MAIL_DOMAIN?: string;
  /** Web host for the app. Defaults to mail.cumuluscloud.app. Not a secret. */
  MAIL_APP_HOST?: string;
  /** "1" refuses mail that would take a mailbox over its plan's storage. Default: off (accept). */
  MAIL_ENFORCE_STORAGE?: string;
  /** Set to "live" to query DNS for SPF, DKIM, and DMARC. Default does not. */
  MAIL_AUTH_DNS?: string;
  /** Fixture resolver for tests. Production leaves this unset. */
  resolver?: DNSResolver;
  /** Test double for Hyperdrive and S3. Production leaves this unset. */
  ingestHooks?: Partial<IngestHooks>;
  /** Outbound SMTP settings (see docs/deploy/outbound-smtp.md). Unset = outside mail stays held. */
  MAIL_SMTP_HOST?: string;
  MAIL_SMTP_PORT?: string;
  MAIL_SMTP_SECURITY?: string;
  MAIL_SMTP_USER?: string;
  MAIL_SMTP_PASSWORD?: string;
  MAIL_SMTP_HELO?: string;
  MAIL_DKIM_SELECTOR?: string;
  MAIL_DKIM_PRIVATE_KEY?: string;
  MAIL_OUTBOUND_DEV?: string;
  /** Test double for the outbound transport. Production leaves this unset. */
  outbound?: OutboundConfig | null;
  /** Test double for the TCP dialer. Production uses `cloudflare:sockets`. */
  smtpDial?: SmtpDial;
};

/** Outbound config from the worker's own bindings (not process.env, which Workers may leave empty). */
export function workerOutbound(env: EmailEnv): OutboundConfig | null {
  if (env.outbound !== undefined) return env.outbound;
  return outboundFromEnv({
    MAIL_SMTP_HOST: env.MAIL_SMTP_HOST,
    MAIL_SMTP_PORT: env.MAIL_SMTP_PORT,
    MAIL_SMTP_SECURITY: env.MAIL_SMTP_SECURITY,
    MAIL_SMTP_USER: env.MAIL_SMTP_USER,
    MAIL_SMTP_PASSWORD: env.MAIL_SMTP_PASSWORD,
    MAIL_SMTP_HELO: env.MAIL_SMTP_HELO,
    MAIL_DKIM_SELECTOR: env.MAIL_DKIM_SELECTOR,
    MAIL_DKIM_PRIVATE_KEY: env.MAIL_DKIM_PRIVATE_KEY,
    MAIL_OUTBOUND_DEV: env.MAIL_OUTBOUND_DEV,
  }, env.smtpDial ?? dialCloudflare);
}

export type ScheduledReport = ReleaseReport & { outbound: QueueReport | null };

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "inbound failed";
  if (/postgres(ql)?:\/\//i.test(message)) return "inbound failed";
  return message.slice(0, 300);
}

async function rawBytes(raw: EmailMessage["raw"]): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(await new Response(raw).arrayBuffer());
}

export async function handleEmail(
  message: EmailMessage,
  env: EmailEnv,
): Promise<{ stored: string[]; rejected?: "mailbox_full" }> {
  const opened = env.ingest ? null : await openWorkerIngest(env, env.ingestHooks);
  const ingest = env.ingest ?? opened;
  if (!ingest) {
    throw new Error(
      "Cumulus mail inbound ingest is not configured. This worker template is not deployed.",
    );
  }
  try {
    const domain = (env.MAIL_DOMAIN || "cumuluscloud.app").trim().toLowerCase();
    const bracket = /<([^>]+)>/.exec(message.to);
    const recipient = (bracket?.[1] ?? message.to).trim().toLowerCase();
    if (!recipient.endsWith(`@${domain}`)) {
      return { stored: [] };
    }
    const inbound: InboundEmail = {
      from: message.from,
      to: recipient,
      raw: await rawBytes(message.raw),
    };
    const stored = await ingestInboundEmail(
      ingest.db,
      ingest.storageFor,
      inbound,
      env.resolver ?? resolverFromEnv(env),
      { enforceStorage: storageEnforced(env.MAIL_ENFORCE_STORAGE) },
    );
    if (stored.rejected === "mailbox_full") {
      message.setReject?.("552 5.2.2 Mailbox full");
      console.log(JSON.stringify({ event: "mail.inbound.rejected", reason: "mailbox_full", domain }));
      return stored;
    }
    console.log(
      JSON.stringify({ event: "mail.inbound.stored", stored: stored.stored.length, domain }),
    );
    return stored;
  } finally {
    await opened?.close();
  }
}

/**
 * Cron handler (`triggers.crons` in wrangler.jsonc). Releases scheduled
 * drafts and expired undo holds when no tab is open, then sends due rows of
 * the outbound SMTP queue (retries included) when SMTP is configured.
 */
export async function handleScheduled(env: EmailEnv, now = Date.now()): Promise<ScheduledReport> {
  const opened = env.ingest ? null : await openWorkerIngest(env, env.ingestHooks);
  const ingest = env.ingest ?? opened;
  if (!ingest) {
    throw new Error(
      "Cumulus mail inbound ingest is not configured. This worker template is not deployed.",
    );
  }
  try {
    const released = await releaseScheduledMail(ingest.db, ingest.storageFor, now);
    // Retries for outside mail: every due queue row, all tenants. Off unless SMTP is configured.
    const outbound = workerOutbound(env);
    const queue = outbound ? await processOutboundQueue(ingest.db, outbound, { now: new Date(now) }) : null;
    // Account deletions whose 7-day grace period has ended: hard delete, every row and blob.
    const { purgeDueDeletions } = await import("../../../src/lib/mail/account-deletion.ts");
    const deletions = await purgeDueDeletions(ingest.db, ingest.storageFor, new Date(now));
    const report: ScheduledReport = { ...released, outbound: queue };
    console.log(JSON.stringify({ event: "mail.schedule.ran", ...released, outbound: queue, deletions }));
    return report;
  } finally {
    await opened?.close();
  }
}

export default {
  async scheduled(controller: { scheduledTime?: number } | undefined, env: EmailEnv, _ctx?: unknown): Promise<void> {
    try {
      await handleScheduled(env, controller?.scheduledTime ?? Date.now());
    } catch (error) {
      console.error(JSON.stringify({ event: "mail.schedule.failed", error: safeError(error) }));
      throw error;
    }
  },

  async email(message: EmailMessage, env: EmailEnv, _ctx?: unknown): Promise<void> {
    try {
      await handleEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "mail.inbound.failed", error: safeError(error) }));
      throw error;
    }
  },
};
