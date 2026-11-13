import { resolverFromEnv, type DNSResolver } from "../../../src/lib/mail/authenticate.ts";
import type { TenantStorage } from "../../../src/lib/mail/delivery.ts";
import { ingestInboundEmail, storageEnforced, type InboundEmail } from "../../../src/lib/mail/inbound.ts";
import type { MailQuery } from "../../../src/lib/mail/query.ts";
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
};

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

export default {
  async email(message: EmailMessage, env: EmailEnv, _ctx?: unknown): Promise<void> {
    try {
      await handleEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "mail.inbound.failed", error: safeError(error) }));
      throw error;
    }
  },
};
