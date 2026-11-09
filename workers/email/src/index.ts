import { resolverFromEnv, type DNSResolver } from "../../../src/lib/mail/authenticate.ts";
import type { TenantStorage } from "../../../src/lib/mail/delivery.ts";
import { ingestInboundEmail, type InboundEmail } from "../../../src/lib/mail/inbound.ts";
import type { MailQuery } from "../../../src/lib/mail/query.ts";

/**
 * Cloudflare Email Routing `email()` handler.
 * Template only: this file is not deployed, and it has no send binding.
 * The host injects `env.ingest` with the same storage interface the app uses.
 * Without that binding the handler refuses the message.
 */
export type InboundDeps = {
  db: MailQuery;
  storageFor: TenantStorage;
};

export type EmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | Uint8Array;
};

export type EmailEnv = {
  ingest?: InboundDeps;
  /** Defaults to cumuluscloud.app. Not a secret. */
  MAIL_DOMAIN?: string;
  /** Web host for the app. Defaults to mail.cumuluscloud.app. Not a secret. */
  MAIL_APP_HOST?: string;
  /** Set to "live" to query DNS for SPF, DKIM, and DMARC. Default does not. */
  MAIL_AUTH_DNS?: string;
  /** Fixture resolver for tests. Production leaves this unset. */
  resolver?: DNSResolver;
  /**
   * Opt-in geo annotation. Unset leaves mail unchanged.
   * Accepted values that turn it on: 1, true, on, yes.
   */
  INFINITUM_GEO_ENABLED?: string;
};

async function rawBytes(raw: EmailMessage["raw"]): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(await new Response(raw).arrayBuffer());
}

export async function handleEmail(message: EmailMessage, env: EmailEnv): Promise<{ stored: string[] }> {
  if (!env.ingest) {
    throw new Error("Cumulus mail inbound ingest is not configured. This worker template is not deployed.");
  }
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
  return ingestInboundEmail(env.ingest.db, env.ingest.storageFor, inbound, env.resolver ?? resolverFromEnv(env), {
    INFINITUM_GEO_ENABLED: env.INFINITUM_GEO_ENABLED,
  });
}

export default {
  async email(message: EmailMessage, env: EmailEnv): Promise<void> {
    await handleEmail(message, env);
  },
};
