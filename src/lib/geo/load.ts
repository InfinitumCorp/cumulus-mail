import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeGeoIpList, decodeGeoSiteList, type GeoDatasets } from "./dat.ts";

type Cache = {
  dir: string;
  geoipMtime: number;
  geositeMtime: number;
  data: GeoDatasets;
};

let cache: Cache | null = null;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/** Read geoip.dat and geosite.dat. Missing files return null. A checksum is enforced by the fetch script. */
export function loadGeoDatasets(dir: string): GeoDatasets | null {
  const geoipPath = join(dir, "geoip.dat");
  const geositePath = join(dir, "geosite.dat");
  let geoipStat;
  let geositeStat;
  try {
    geoipStat = statSync(geoipPath);
    geositeStat = statSync(geositePath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  if (
    cache &&
    cache.dir === dir &&
    cache.geoipMtime === geoipStat.mtimeMs &&
    cache.geositeMtime === geositeStat.mtimeMs
  ) {
    return cache.data;
  }
  const data: GeoDatasets = {
    ip: decodeGeoIpList(readFileSync(geoipPath)),
    site: decodeGeoSiteList(readFileSync(geositePath)),
  };
  cache = { dir, geoipMtime: geoipStat.mtimeMs, geositeMtime: geositeStat.mtimeMs, data };
  return data;
}

export function resetGeoCache(): void {
  cache = null;
}
