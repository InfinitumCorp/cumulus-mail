import type { GeoAnnotation, MailMessage } from "../mail/model.ts";
import type { MailQuery } from "../mail/query.ts";
import { lookupCategories, lookupCountry, type GeoIpList, type GeoSiteList } from "./dat.ts";
import { loadGeoLists, resetGeoCache, type GeoLists } from "./load.ts";

let unavailableLogged = false;

export function resetGeoHook(): void {
  unavailableLogged = false;
  resetGeoCache();
}

const ON = new Set(["1", "true", "on", "yes"]);

/**
 * Server opt-in. Unset, empty, and every value other than 1/true/on/yes stay off.
 * An explicit string, including "0", wins over process.env.
 */
export function infinitumGeoEnabled(explicit?: string | null): boolean {
  const raw =
    explicit === undefined || explicit === null ? process.env.INFINITUM_GEO_ENABLED : explicit;
  return ON.has(raw?.trim().toLowerCase() ?? "");
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export type GeoPolicy = {
  disposition: "deliver" | "quarantine";
  note: string | null;
};

/**
 * Geo routing only observes country and category. Disposition is returned unchanged.
 */
export function geoPolicy(
  disposition: "deliver" | "quarantine",
  annotation: GeoAnnotation | null,
): GeoPolicy {
  if (!annotation) return { disposition, note: null };
  const country = annotation.country ?? "none";
  const categories = annotation.categories.length ? annotation.categories.join(",") : "none";
  return { disposition, note: `geo policy observe country=${country} categories=${categories}` };
}

export function annotateMessage(
  message: MailMessage,
  lists: { geoip: GeoIpList; geosite: GeoSiteList },
  hints: { ip?: string; domain?: string },
): MailMessage {
  const country = hints.ip ? lookupCountry(lists.geoip, hints.ip) : null;
  const categories = hints.domain ? lookupCategories(lists.geosite, hints.domain) : [];
  const geo: GeoAnnotation = {
    country: country ? country.slice(0, 32) : null,
    categories: categories.slice(0, 32).map((category) => category.slice(0, 64)),
  };
  return { ...message, geo };
}

type HookOptions = {
  /** When set, this value is the switch. Undefined reads INFINITUM_GEO_ENABLED. */
  enabled?: boolean;
  explicitEnv?: string | null;
  lists?: GeoLists | null;
  log?: (line: string) => void;
  /** Test seam. When omitted, the mailbox column is read. */
  routing?: boolean;
};

async function routingEnabled(
  db: MailQuery,
  tenantId: string,
  options: HookOptions,
): Promise<boolean> {
  if (options.routing !== undefined) return options.routing;
  const rows = await db.query<{ geo_routing: boolean }>(
    `select geo_routing from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.geo_routing === true;
}

/**
 * Annotate only when the server flag and the mailbox toggle are both on.
 * Otherwise the same message object is returned and nothing is logged.
 */
export async function applyGeoHook(
  db: MailQuery,
  tenantId: string,
  message: MailMessage,
  hints: { ip?: string; domain?: string },
  options: HookOptions = {},
): Promise<MailMessage> {
  const enabled = options.enabled ?? infinitumGeoEnabled(options.explicitEnv);
  if (!enabled) return message;
  if (!(await routingEnabled(db, tenantId, options))) return message;
  const log = options.log ?? console.info;
  const lists = options.lists === undefined ? loadGeoLists() : options.lists;
  if (!lists) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      log("geo data unavailable");
    }
    return message;
  }
  const annotated = annotateMessage(message, lists, hints);
  const decision = geoPolicy(message.auth?.disposition ?? "deliver", annotated.geo ?? null);
  if (decision.note) log(decision.note);
  if (decision.disposition !== (message.auth?.disposition ?? "deliver")) return message;
  return annotated;
}
