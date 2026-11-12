import { readFileSync } from "node:fs";
import { mailDomain } from "../domain.ts";
import { dialNode } from "./node-socket.ts";
import { createSmtpTransport, type SmtpDial } from "./smtp.ts";
import type { OutboundTransport } from "./transport.ts";
import { createMemoryTransport } from "./transport.ts";
import type { DkimOptions } from "./dkim.ts";

/**
 * Outbound settings, read only from the environment. With no MAIL_SMTP_HOST
 * this returns null and mail to outside addresses is held exactly as before.
 *
 *   MAIL_SMTP_HOST        relay host. Unset = outbound off.
 *   MAIL_SMTP_PORT        default 587
 *   MAIL_SMTP_SECURITY    starttls (default) | tls
 *   MAIL_SMTP_USER        optional AUTH PLAIN user
 *   MAIL_SMTP_PASSWORD    optional, a secret: set it with the platform's secret store
 *   MAIL_SMTP_HELO        EHLO name, default the mail domain
 *   MAIL_DKIM_SELECTOR    with a key, turns DKIM signing on (d= is the sender's domain)
 *   MAIL_DKIM_KEY_PATH    PEM file (Node hosts)
 *   MAIL_DKIM_PRIVATE_KEY PEM text (Workers, where there is no file system), a secret
 *   MAIL_OUTBOUND_DEV     "memory" = accept everything in memory, never send (local dev)
 */
export type OutboundConfig = {
  transport: OutboundTransport;
  dkim: Omit<DkimOptions, "domain" | "timestamp"> | null;
};

type Env = Record<string, string | undefined>;

export function outboundFromEnv(env: Env = process.env, dial: SmtpDial = dialNode): OutboundConfig | null {
  const dkim = dkimFromEnv(env);
  if (env.MAIL_OUTBOUND_DEV?.trim() === "memory") return { transport: createMemoryTransport(), dkim };
  const host = env.MAIL_SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.MAIL_SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("MAIL_SMTP_PORT must be a port number");
  const security = (env.MAIL_SMTP_SECURITY?.trim().toLowerCase() || (port === 465 ? "tls" : "starttls")) as "tls" | "starttls";
  if (security !== "tls" && security !== "starttls") throw new Error("MAIL_SMTP_SECURITY must be tls or starttls");
  return {
    transport: createSmtpTransport({
      host,
      port,
      security,
      user: env.MAIL_SMTP_USER?.trim() || undefined,
      password: env.MAIL_SMTP_PASSWORD,
      helo: env.MAIL_SMTP_HELO?.trim() || mailDomain(),
      dial,
    }),
    dkim,
  };
}

function dkimFromEnv(env: Env): OutboundConfig["dkim"] {
  const selector = env.MAIL_DKIM_SELECTOR?.trim();
  if (!selector) return null;
  const inline = env.MAIL_DKIM_PRIVATE_KEY?.trim();
  const path = env.MAIL_DKIM_KEY_PATH?.trim();
  const privateKeyPem = inline ? inline.replace(/\\n/g, "\n") : path ? readFileSync(path, "utf8") : "";
  if (!privateKeyPem) throw new Error("MAIL_DKIM_SELECTOR needs MAIL_DKIM_KEY_PATH or MAIL_DKIM_PRIVATE_KEY");
  return { selector, privateKeyPem };
}

/** True when the environment turns outbound sending on. */
export function outboundEnabled(env: Env = process.env): boolean {
  return Boolean(env.MAIL_SMTP_HOST?.trim() || env.MAIL_OUTBOUND_DEV?.trim() === "memory");
}

let override: OutboundConfig | null | undefined;
let cached: { key: string; config: OutboundConfig | null } | undefined;

/** Tests and hosts can inject a config (or null to force "off"). Pass undefined to go back to the environment. */
export function configureOutbound(config: OutboundConfig | null | undefined): void {
  override = config;
  cached = undefined;
}

/** The active outbound config: an injected one, else the environment's (built once per settings). */
export function currentOutbound(): OutboundConfig | null {
  if (override !== undefined) return override;
  if (!outboundEnabled()) return null;
  const env = process.env;
  const key = [env.MAIL_SMTP_HOST, env.MAIL_SMTP_PORT, env.MAIL_SMTP_SECURITY, env.MAIL_SMTP_USER, env.MAIL_DKIM_SELECTOR, env.MAIL_OUTBOUND_DEV].join("|");
  if (!cached || cached.key !== key) cached = { key, config: outboundFromEnv(env) };
  return cached.config;
}
