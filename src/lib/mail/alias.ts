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
const LOCAL_PART = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

/**
 * Why a newly added alias can't be added, or null. Every local part on the platform domain is also a Cumulus://ID
 * username, so there an alias must be one Mail made (word.word.NNNN, which Cumulus://ID never hands out) or start with
 * the owner's own name (alex.shop, alex-shop, alex+shop). That keeps people off each other's future names and off
 * system addresses (security@, postmaster@). On other domains: only domains this mailbox has verified.
 */
export function aliasProblem(alias: string, ownAddress: string, verifiedDomains: string[], platformDomain: string = mailDomain()): string | null {
  const email = alias.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (at < 1 || !LOCAL_PART.test(local)) return "That address isn't valid.";
  if (domain === platformDomain.toLowerCase()) {
    const own = ownAddress.toLowerCase().split("@")[0] ?? "";
    if (RANDOM_LOCAL.test(local)) return null;
    if (own && local.length > own.length + 1 && local.startsWith(own) && ".-+".includes(local[own.length]!)) return null;
    return `An extra @${domain} address has to start with your name, like ${own}.shop.`;
  }
  if (verifiedDomains.map((d) => d.toLowerCase()).includes(domain)) return null;
  return `Add and verify ${domain} under Domains before using it for an address.`;
}
