import type { MailMessage } from "../mail/model.ts";
import { lookupCategories, lookupCountry, type GeoIPList, type GeoSiteList } from "./dat.ts";

/** Server switch. Unset, empty, and every value other than the ones below stay off. */
export function infinitumGeoEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env.INFINITUM_GEO_ENABLED ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function mailboxGeoEnabled(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export type GeoNote = {
  country: string | null;
  categories: string[];
};

const CATEGORY_LABEL_LIMIT = 12;

export function geoNote(input: {
  ip?: string | null;
  domain?: string | null;
  geoip?: GeoIPList | null;
  geosite?: GeoSiteList | null;
}): GeoNote {
  return {
    country: input.ip && input.geoip ? lookupCountry(input.geoip, input.ip) : null,
    categories: input.domain && input.geosite ? lookupCategories(input.geosite, input.domain) : [],
  };
}

/**
 * Adds country and category labels. Folder, auth, and body stay as they were.
 * Returns the same message when there is nothing to add.
 */
export function annotateMessage(message: MailMessage, note: GeoNote): MailMessage {
  const extra: string[] = [];
  if (note.country) extra.push(`geo:${note.country}`);
  for (const category of note.categories) {
    if (extra.length >= CATEGORY_LABEL_LIMIT) break;
    extra.push(`site:${category}`);
  }
  const labels = [...message.labels];
  let added = false;
  for (const label of extra) {
    if (labels.includes(label)) continue;
    labels.push(label);
    added = true;
  }
  if (!added) return message;
  return { ...message, labels };
}

/**
 * Both the server switch and the mailbox switch must be on.
 * When either is off the message is returned unchanged and nothing is logged.
 */
export function applyGeoPolicy(
  message: MailMessage,
  input: {
    envEnabled: boolean;
    userEnabled: boolean;
    ip?: string | null;
    domain?: string | null;
    geoip?: GeoIPList | null;
    geosite?: GeoSiteList | null;
    log?: (line: string) => void;
  },
): MailMessage {
  if (!input.envEnabled || !input.userEnabled) return message;
  const note = geoNote(input);
  input.log?.(
    `geo route country=${note.country ?? "-"} categories=${note.categories.join(",") || "-"}`,
  );
  return annotateMessage(message, note);
}
