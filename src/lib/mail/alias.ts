import { mailDomain } from "./domain.ts";

export const ALIAS_WORDS = ["north", "quiet", "glass", "harbor", "lumen", "cedar", "field", "orbit", "paper", "signal"];

/** A random `word.word.NNNN@domain` alias. */
export function newAlias(random: () => number = Math.random, domain: string = mailDomain()): string {
  const a = ALIAS_WORDS[Math.floor(random() * ALIAS_WORDS.length)] ?? "north";
  const b = ALIAS_WORDS[Math.floor(random() * ALIAS_WORDS.length)] ?? "quiet";
  const n = Math.floor(1000 + random() * 9000);
  return `${a}.${b}.${n}@${domain}`;
}

const RANDOM_LOCAL = new RegExp(`^(${ALIAS_WORDS.join("|")})\\.(${ALIAS_WORDS.join("|")})\\.\\d{4}$`);
// Letters, digits, ".", "_", "-", "+"; no leading, trailing or doubled dot.
const LOCAL_PART = /^[a-z0-9_](?:(?:[a-z0-9_+-]|\.(?!\.))*[a-z0-9_+-])?$/;

/**
 * Why a newly added alias can't be added, or null. Every local part on the platform domain may be a Cumulus://ID
 * username (letters, digits, ".", "_", "-"). So there an alias must be one Mail made (word.word.NNNN, which Cumulus://ID
 * never hands out as a username) or your own name plus "+" and a tag (alex+shop): "+" never appears in a username, so
 * no alias can ever be someone's (future) address or a system address like security@. On other domains: only domains
 * this mailbox has verified.
 */
export function aliasProblem(alias: string, ownAddress: string, verifiedDomains: string[], platformDomain: string = mailDomain()): string | null {
  const email = alias.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (at < 1 || local.length > 64 || !LOCAL_PART.test(local)) return "That address isn't valid.";
  if (domain === platformDomain.toLowerCase()) {
    const own = ownAddress.toLowerCase().split("@")[0] ?? "";
    if (RANDOM_LOCAL.test(local)) return null;
    if (own && local.length > own.length + 1 && local.startsWith(`${own}+`)) return null;
    return `An extra @${domain} address has to be your name, a plus and a word, like ${own}+shop.`;
  }
  if (verifiedDomains.map((d) => d.toLowerCase()).includes(domain)) return null;
  return `Add and verify ${domain} under Domains before using it for an address.`;
}

/** The aliases to store from a save or a restore: ones this mailbox already has, plus new ones that pass aliasProblem. */
export function allowedAliases(incoming: string[], held: string[], ownAddress: string, verifiedDomains: string[], platformDomain: string = mailDomain()): string[] {
  const kept = new Set(held.map((a) => a.toLowerCase()));
  const out: string[] = [];
  for (const raw of incoming) {
    const email = raw.trim().toLowerCase();
    if (out.includes(email) || email === ownAddress.toLowerCase()) continue;
    if (kept.has(email) || aliasProblem(email, ownAddress, verifiedDomains, platformDomain) === null) out.push(email);
  }
  return out;
}
