import { join } from "node:path";
import { lookupCategories, lookupCountry, type GeoDatasets } from "./dat.ts";

/**
 * Opt-in geo annotation. INFINITUM_GEO_ENABLED defaults off.
 * When it is off, callers get the same message and the same delivery text
 * back, and the .dat files are not opened.
 * When it is on, a country and site category may be recorded on headers or
 * appended to a delivery detail. DMARC disposition, folder, and quarantine
 * policy are left alone.
 */

const ENABLED = new Set(["1", "true", "yes", "on"]);

export type GeoEnv = {
  INFINITUM_GEO_ENABLED?: string;
  INFINITUM_GEO_DIR?: string;
};

export type GeoHookOptions = {
  env?: GeoEnv;
  datasets?: GeoDatasets | null;
  log?: (message: string) => void;
};

export type GeoPeer = {
  ip?: string;
  domain?: string;
};

let missingWarned = false;

export function resetGeoHookState(): void {
  missingWarned = false;
}

export function geoEnabled(env: GeoEnv = process.env): boolean {
  return ENABLED.has((env.INFINITUM_GEO_ENABLED ?? "").trim().toLowerCase());
}

export function geoDir(env: GeoEnv = process.env): string {
  const configured = env.INFINITUM_GEO_DIR?.trim();
  if (configured) return configured;
  return join(process.cwd(), "data", "geo");
}

export function emailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "";
  return trimmed.slice(at + 1);
}

function envOf(options?: GeoHookOptions): GeoEnv {
  return options?.env ?? process.env;
}

function emit(options: GeoHookOptions | undefined, message: string, warn = false): void {
  if (options?.log) {
    options.log(message);
    return;
  }
  if (warn) console.warn(message);
  else console.info(message);
}

async function resolveDatasets(
  options: GeoHookOptions | undefined,
  env: GeoEnv,
): Promise<GeoDatasets | null> {
  if (options && "datasets" in options) return options.datasets ?? null;
  const dir = geoDir(env);
  try {
    const { loadGeoDatasets } = await import("./load.ts");
    const data = loadGeoDatasets(dir);
    if (!data) warnMissing(dir, options);
    return data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unreadable geo dataset";
    warnMissing(dir, options, detail);
    return null;
  }
}

function warnMissing(dir: string, options: GeoHookOptions | undefined, detail?: string): void {
  if (missingWarned) return;
  missingWarned = true;
  const suffix = detail ? ` (${detail})` : "";
  emit(options, `[cumulus-mail] geo datasets are not in ${dir}; annotation skipped${suffix}`, true);
}

function noteFor(
  datasets: GeoDatasets,
  peer: GeoPeer,
): { country: string | null; categories: string[] } {
  return {
    country: peer.ip ? lookupCountry(datasets.ip, peer.ip) : null,
    categories: peer.domain ? lookupCategories(datasets.site, peer.domain) : [],
  };
}

export async function annotateMessage<T extends { headers?: Record<string, string> }>(
  message: T,
  peer: GeoPeer,
  options?: GeoHookOptions,
): Promise<T> {
  const env = envOf(options);
  if (!geoEnabled(env)) return message;
  const datasets = await resolveDatasets(options, env);
  if (!datasets) return message;
  const note = noteFor(datasets, peer);
  if (!note.country && note.categories.length === 0) return message;
  const headers = { ...(message.headers ?? {}) };
  if (note.country) headers["x-infinitum-geo-country"] = note.country;
  if (note.categories.length > 0) headers["x-infinitum-geo-site"] = note.categories.join(",");
  emit(
    options,
    `[cumulus-mail] geo country=${note.country ?? "-"} site=${note.categories.join(",") || "-"}`,
  );
  return { ...message, headers };
}

export async function annotateDeliveryDetail(
  detail: string,
  email: string,
  options?: GeoHookOptions,
): Promise<string> {
  const env = envOf(options);
  if (!geoEnabled(env)) return detail;
  const domain = emailDomain(email);
  if (!domain) return detail;
  const datasets = await resolveDatasets(options, env);
  if (!datasets) return detail;
  const categories = lookupCategories(datasets.site, domain);
  if (categories.length === 0) return detail;
  emit(options, `[cumulus-mail] geo site=${categories.join(",")} domain=${domain}`);
  return `${detail} Geo site: ${categories.join(",")}.`;
}
