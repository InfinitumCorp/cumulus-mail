import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeGeoIPList, decodeGeoSiteList, type GeoIPList, type GeoSiteList } from "./dat.ts";

let cached: { dir: string; geoip: GeoIPList; geosite: GeoSiteList } | null = null;
let warned = false;

export function geoDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.INFINITUM_GEO_DIR?.trim();
  return configured || join(process.cwd(), "data", "geo");
}

export function resetGeoCache(): void {
  cached = null;
  warned = false;
}

export function loadGeoDatasets(dir: string): { geoip: GeoIPList; geosite: GeoSiteList } {
  if (cached?.dir === dir) return { geoip: cached.geoip, geosite: cached.geosite };
  const geoip = decodeGeoIPList(readFileSync(join(dir, "geoip.dat")));
  const geosite = decodeGeoSiteList(readFileSync(join(dir, "geosite.dat")));
  cached = { dir, geoip, geosite };
  return { geoip, geosite };
}

/** Missing or unreadable datasets skip annotation. The warning is logged once. */
export function readGeoDatasets(dir: string): { geoip: GeoIPList; geosite: GeoSiteList } | null {
  try {
    return loadGeoDatasets(dir);
  } catch {
    if (!warned) {
      warned = true;
      console.info("geo route skipped: datasets unavailable");
    }
    return null;
  }
}
