import { mailDomain } from "./domain.ts";

const ALIAS_WORDS = ["north", "quiet", "glass", "harbor", "lumen", "cedar", "field", "orbit", "paper", "signal"];

/** A random `word.word.NNNN@domain` alias. */
export function newAlias(random: () => number = Math.random, domain: string = mailDomain()): string {
  const a = ALIAS_WORDS[Math.floor(random() * ALIAS_WORDS.length)] ?? "north";
  const b = ALIAS_WORDS[Math.floor(random() * ALIAS_WORDS.length)] ?? "quiet";
  const n = Math.floor(1000 + random() * 9000);
  return `${a}.${b}.${n}@${domain}`;
}
