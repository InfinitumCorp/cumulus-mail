import type { MailMessage } from "./model.ts";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export type LinkCheck = {
  href: string;
  suspicious: boolean;
  reason?: string;
};

export function extractLinks(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  const unique: string[] = [];
  for (const link of found) {
    const href = link.replace(/[.,;:]+$/g, "");
    if (!unique.includes(href)) unique.push(href);
  }
  return unique.slice(0, 20);
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function lookalike(host: string): boolean {
  if (!host || host === "cumuluscloud.app" || host.endsWith(".cumuluscloud.app")) return false;
  const squashed = host.replace(/[^a-z0-9]/g, "");
  return squashed.includes("cumuluscloud") || squashed.includes("cumulusmail");
}

export function classifyLink(href: string): LinkCheck {
  const host = hostOf(href);
  if (!host) return { href, suspicious: true, reason: "This link is not a valid web address." };
  if (host.startsWith("xn--")) return { href, suspicious: true, reason: "This link uses punycode. Check the real name before opening it." };
  if (lookalike(host)) return { href, suspicious: true, reason: "This domain imitates Cumulus. It is not cumuluscloud.app." };
  if (href.includes("@") && href.includes("://")) {
    const user = href.split("://")[1]?.split("@")[0] ?? "";
    if (user.includes("cumulus")) return { href, suspicious: true, reason: "The link hides its real host behind a Cumulus-looking name." };
  }
  return { href, suspicious: false };
}

/** Drop remote image URLs. Plain-text mail never loads them; HTML mail must not either. */
export function stripRemoteImages(html: string): { html: string; blocked: number } {
  let blocked = 0;
  const htmlOut = html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (!/\ssrc\s*=\s*["']?https?:/i.test(tag) && !/\ssrc\s*=\s*https?:/i.test(tag)) return tag;
    blocked += 1;
    return "";
  });
  return { html: htmlOut, blocked };
}

export function assessPhishing(message: MailMessage): { verdict: "ok" | "review" | "phishing"; reasons: string[] } {
  const reasons: string[] = [];
  const fromDomain = message.from.email.split("@")[1]?.toLowerCase() ?? "";
  const display = message.from.name.toLowerCase();
  const claimsCumulus = /cumulus|cid security|infinitum/.test(display);
  if (claimsCumulus && fromDomain !== "cumuluscloud.app") {
    reasons.push("The sender name claims Cumulus, and the address is outside cumuluscloud.app.");
  }
  if (message.auth?.disposition === "quarantine") {
    reasons.push("SPF, DKIM, or DMARC asked for quarantine.");
  }
  const links = extractLinks(`${message.subject}\n${message.body}`);
  for (const link of links) {
    const check = classifyLink(link);
    if (check.suspicious && check.reason) reasons.push(check.reason);
  }
  const urgent = /password|verify your|urgent|suspended|wire transfer/i.test(`${message.subject}\n${message.body}`);
  if (urgent && links.some((link) => !hostOf(link).endsWith("cumuluscloud.app"))) {
    reasons.push("The message asks for urgent action and links off Cumulus.");
  }
  const images = stripRemoteImages(message.body);
  if (images.blocked > 0) reasons.push(`${images.blocked} remote image${images.blocked === 1 ? "" : "s"} blocked.`);
  if (reasons.some((reason) => reason.startsWith("The sender name") || reason.includes("imitates") || message.auth?.disposition === "quarantine")) {
    return { verdict: "phishing", reasons };
  }
  if (reasons.length) return { verdict: "review", reasons };
  return { verdict: "ok", reasons: [] };
}
