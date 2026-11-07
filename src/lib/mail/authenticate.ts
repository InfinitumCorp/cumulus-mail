import { authenticate, type DNSResolver } from "mailauth";
import type { MailAuth } from "./model.ts";

export type { DNSResolver };

/** Resolver that answers nothing. Tests use this or a fixture map. It does not query the network. */
export const emptyResolver: DNSResolver = async () => [];

/**
 * Live DNS, only when `MAIL_AUTH_DNS=live`. The default stays on `emptyResolver`
 * so tests and the undeployed worker do not query the network.
 */
export const liveResolver: DNSResolver = async (name, rrtype) => {
  const dns = await import("node:dns/promises");
  const type = rrtype.toUpperCase();
  if (type === "TXT") return dns.resolveTxt(name);
  if (type === "MX") return (await dns.resolveMx(name)).map((row) => [`${row.priority} ${row.exchange}`]);
  if (type === "A") return (await dns.resolve4(name)).map((row) => [row]);
  if (type === "AAAA") return (await dns.resolve6(name)).map((row) => [row]);
  return [];
};

export function resolverFromEnv(env: { MAIL_AUTH_DNS?: string } = process.env): DNSResolver {
  return env.MAIL_AUTH_DNS === "live" ? liveResolver : emptyResolver;
}

export type InboundEnvelope = {
  sender: string;
  ip: string;
  helo: string;
};

/**
 * SPF, DKIM and DMARC via mailauth. `resolver` is required so a test cannot
 * fall through to live DNS. A failing DMARC policy of quarantine or reject
 * keeps the message out of the inbox.
 */
export async function authenticateInbound(
  raw: Uint8Array | string,
  envelope: InboundEnvelope,
  resolver: DNSResolver,
): Promise<MailAuth> {
  const result = await authenticate(Buffer.from(raw), {
    sender: envelope.sender,
    ip: envelope.ip,
    helo: envelope.helo,
    mta: "mail.cumuluscloud.app",
    resolver,
    disableArc: true,
    disableBimi: true,
  });
  const spf = result.spf ? result.spf.status.result : "none";
  const dkimResults = result.dkim?.results ?? [];
  const dkim = dkimResults.some((row) => row.status?.result === "pass")
    ? "pass"
    : dkimResults[0]?.status?.result ?? "none";
  const dmarcRecord = result.dmarc ? result.dmarc : null;
  const dmarc = dmarcRecord ? dmarcRecord.status.result : "none";
  const policy = (dmarcRecord?.policy ?? "none").toLowerCase();
  const failing = dmarc === "fail";
  const disposition = failing && (policy === "quarantine" || policy === "reject") ? "quarantine" : "deliver";
  return { spf, dkim, dmarc, policy, disposition };
}
