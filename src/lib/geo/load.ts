import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGeoIpList, parseGeoSiteList, type GeoIpList, type GeoSiteList } from "./dat.ts";

export type GeoLists = { geoip: GeoIpList; geosite: GeoSiteList };

let cache: { key: string; lists: GeoLists } | null = null;

/** Directory of the fetched .dat files. INFINITUM_GEO_DIR overrides the default .data/geo. */
export function geoDataDir(): string {
  const override = process.env.INFINITUM_GEO_DIR?.trim();
  if (override) return override;
  return fileURLToPath(new URL("../../../.data/geo/", import.meta.url));
}

export function resetGeoCache(): void {
  cache = null;
}

/**
 * Read geoip.dat and geosite.dat. Missing or unreadable files return null
 * so mail delivery can continue with no annotation.
 */
export function loadGeoLists(dir = geoDataDir()): GeoLists | null {
  const ipPath = join(dir, "geoip.dat");
  const sitePath = join(dir, "geosite.dat");
  if (!existsSync(ipPath) || !existsSync(sitePath)) return null;
  try {
    const ipStat = statSync(ipPath);
    const siteStat = statSync(sitePath);
    const key = `${ipPath}:${ipStat.mtimeMs}:${ipStat.size}:${sitePath}:${siteStat.mtimeMs}:${siteStat.size}`;
    if (cache?.key === key) return cache.lists;
    const lists = {
      geoip: parseGeoIpList(readFileSync(ipPath)),
      geosite: parseGeoSiteList(readFileSync(sitePath)),
    };
    cache = { key, lists };
    return lists;
  } catch {
    return null;
  }
}
