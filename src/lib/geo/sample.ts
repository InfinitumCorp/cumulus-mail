import {
  DomainType,
  encodeDomainAttribute,
  encodeGeoIpList,
  encodeGeoSiteList,
  type GeoDatasets,
  type GeoIpEntry,
  type GeoSiteEntry,
} from "./dat.ts";

/** Tiny stand-in for the v2fly lists. Tests use this instead of the real .dat files. */
export function syntheticGeoDatasets(): GeoDatasets {
  const ip: GeoIpEntry[] = [
    {
      countryCode: "PRIVATE",
      cidrs: [{ ip: Uint8Array.of(10, 0, 0, 0), prefix: 8 }],
      reverseMatch: false,
    },
    {
      countryCode: "US",
      cidrs: [
        { ip: Uint8Array.of(192, 0, 2, 0), prefix: 24 },
        {
          ip: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
          prefix: 32,
        },
      ],
      reverseMatch: false,
    },
    {
      countryCode: "CN",
      cidrs: [{ ip: Uint8Array.of(203, 0, 113, 0), prefix: 24 }],
      reverseMatch: false,
    },
    {
      countryCode: "TEST",
      cidrs: [{ ip: Uint8Array.of(198, 51, 100, 0), prefix: 24 }],
      reverseMatch: true,
    },
  ];
  const site: GeoSiteEntry[] = [
    {
      code: "category-ads",
      domains: [
        { type: DomainType.Domain, value: "ads.example" },
        { type: DomainType.Full, value: "tracker.test" },
        { type: DomainType.Plain, value: "doubleclick" },
        { type: DomainType.Regex, value: "^bad\\." },
      ],
    },
    {
      code: "google",
      domains: [{ type: DomainType.Domain, value: "google.com" }],
    },
    {
      code: "cumulus",
      domains: [{ type: DomainType.Domain, value: "cumuluscloud.app" }],
    },
  ];
  return { ip, site };
}

export function syntheticGeoFiles(): { geoip: Uint8Array; geosite: Uint8Array } {
  const data = syntheticGeoDatasets();
  const attribute = encodeDomainAttribute("ads");
  return {
    geoip: encodeGeoIpList(data.ip),
    geosite: encodeGeoSiteList(data.site, [[[], [], [], [attribute]]]),
  };
}
