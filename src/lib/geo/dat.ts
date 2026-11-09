/**
 * Minimal reader for v2ray GeoIPList and GeoSiteList protobufs.
 * No protobuf dependency: only the fields those two messages use.
 *
 * GeoSite.country_code is the category name (for example "google"), not a country.
 */

export const DomainType = {
  Plain: 0,
  Regex: 1,
  Domain: 2,
  Full: 3,
} as const;

export type Cidr = { ip: Uint8Array<ArrayBufferLike>; prefix: number };

export type GeoIP = { code: string; cidrs: Cidr[]; reverse: boolean };

export type GeoIPList = { entries: GeoIP[] };

export type DomainRule = { type: number; value: string };

export type GeoSite = { code: string; domains: DomainRule[] };

export type GeoSiteList = { entries: GeoSite[] };

type RawField = { id: number; num?: number; bytes?: Uint8Array<ArrayBufferLike> };

function readVarint(buf: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buf.length && shift <= 63) {
    const byte = buf[cursor] ?? 0;
    cursor += 1;
    if (shift < 32) value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
  }
  throw new Error("truncated varint");
}

function readMessage(buf: Uint8Array): RawField[] {
  const fields: RawField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const id = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buf, offset);
      offset = value.offset;
      fields.push({ id, num: value.value });
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buf, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (length.value < 0 || end > buf.length) throw new Error("truncated length-delimited field");
      fields.push({ id, bytes: buf.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated 64-bit field");
      offset += 8;
      continue;
    }
    if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated 32-bit field");
      offset += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeCidr(buf: Uint8Array): Cidr {
  let ip: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let prefix = 0;
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.bytes) ip = field.bytes;
    else if (field.id === 2 && field.num !== undefined) prefix = field.num;
  }
  return { ip, prefix };
}

function decodeGeoIP(buf: Uint8Array): GeoIP {
  let code = "";
  const cidrs: Cidr[] = [];
  let reverse = false;
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.bytes) code = text(field.bytes);
    else if (field.id === 2 && field.bytes) cidrs.push(decodeCidr(field.bytes));
    else if (field.id === 3 && field.num !== undefined) reverse = field.num !== 0;
  }
  return { code, cidrs, reverse };
}

function decodeDomain(buf: Uint8Array): DomainRule {
  let type: number = DomainType.Plain;
  let value = "";
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.num !== undefined) type = field.num;
    else if (field.id === 2 && field.bytes) value = text(field.bytes);
  }
  return { type, value };
}

function decodeGeoSite(buf: Uint8Array): GeoSite {
  let code = "";
  const domains: DomainRule[] = [];
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.bytes) code = text(field.bytes);
    else if (field.id === 2 && field.bytes) domains.push(decodeDomain(field.bytes));
  }
  return { code, domains };
}

export function decodeGeoIPList(buf: Uint8Array): GeoIPList {
  const entries: GeoIP[] = [];
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.bytes) entries.push(decodeGeoIP(field.bytes));
  }
  return { entries };
}

export function decodeGeoSiteList(buf: Uint8Array): GeoSiteList {
  const entries: GeoSite[] = [];
  for (const field of readMessage(buf)) {
    if (field.id === 1 && field.bytes) entries.push(decodeGeoSite(field.bytes));
  }
  return { entries };
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] ?? "";
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6Words(side: string): number[] | null {
  if (!side) return [];
  const parts = side.split(":");
  const words: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.includes(".")) {
      if (i !== parts.length - 1) return null;
      const v4 = parseIpv4(part);
      if (!v4) return null;
      words.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Words(halves[0] ?? "");
  if (!left) return null;
  const right = halves.length === 2 ? parseIpv6Words(halves[1] ?? "") : [];
  if (!right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 8) return null;
  const gap = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = halves.length === 2 ? [...left, ...Array<number>(gap).fill(0), ...right] : left;
  if (words.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const word = words[i] ?? 0;
    out[i * 2] = (word >> 8) & 0xff;
    out[i * 2 + 1] = word & 0xff;
  }
  return out;
}

/** IPv4 as 4 bytes, IPv6 as 16 bytes. `::ffff:a.b.c.d` stays 4 bytes so it can match a v4 CIDR. */
export function parseIp(input: string): Uint8Array | null {
  let value = input.trim();
  if (!value) return null;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.toLowerCase().startsWith("::ffff:") && value.includes("."))
    return parseIpv4(value.slice(7));
  if (value.includes(":")) return parseIpv6(value);
  if (value.includes(".")) return parseIpv4(value);
  return null;
}

function asIpv4(ip: Uint8Array): Uint8Array | null {
  if (ip.length === 4) return ip;
  if (ip.length !== 16) return null;
  for (let i = 0; i < 10; i += 1) if (ip[i] !== 0) return null;
  if (ip[10] !== 0xff || ip[11] !== 0xff) return null;
  return ip.subarray(12);
}

export function cidrContains(cidr: Cidr, ip: Uint8Array): boolean {
  let network = cidr.ip;
  let target = ip;
  if (network.length !== target.length) {
    const network4 = asIpv4(network);
    const target4 = asIpv4(target);
    if (!network4 || !target4) return false;
    network = network4;
    target = target4;
  }
  const bits = cidr.prefix;
  const width = network.length * 8;
  if (bits < 0 || bits > width) return false;
  if (bits === 0) return true;
  const full = Math.floor(bits / 8);
  const rem = bits % 8;
  for (let i = 0; i < full; i += 1) if (network[i] !== target[i]) return false;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((network[full] ?? 0) & mask) === ((target[full] ?? 0) & mask);
}

/** First matching entry wins. `reverse` matches addresses outside that entry's CIDRs. */
export function lookupCountry(list: GeoIPList, ip: string): string | null {
  const bytes = parseIp(ip);
  if (!bytes) return null;
  for (const entry of list.entries) {
    if (!entry.code) continue;
    const inside = entry.cidrs.some((cidr) => cidrContains(cidr, bytes));
    if (entry.reverse ? !inside : inside) return entry.code;
  }
  return null;
}

export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  const port = /^(.*):(\d+)$/.exec(host);
  if (port && !port[1]?.includes(":")) host = port[1] ?? host;
  if (!host || host.includes("/") || /\s/.test(host)) return "";
  return host;
}

function domainMatches(rule: DomainRule, host: string): boolean {
  const value = rule.value.trim().toLowerCase();
  if (!value) return false;
  if (rule.type === DomainType.Full) return host === value;
  if (rule.type === DomainType.Domain) return host === value || host.endsWith(`.${value}`);
  if (rule.type === DomainType.Plain) return host.includes(value);
  if (rule.type === DomainType.Regex) {
    if (rule.value.length > 256) return false;
    try {
      return new RegExp(rule.value).test(host);
    } catch {
      return false;
    }
  }
  return false;
}

/** Category names (`GeoSite.country_code`) whose domain rules match. */
export function lookupCategories(list: GeoSiteList, domain: string): string[] {
  const host = normalizeHost(domain);
  if (!host) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of list.entries) {
    if (!entry.code || seen.has(entry.code)) continue;
    if (entry.domains.some((rule) => domainMatches(rule, host))) {
      seen.add(entry.code);
      found.push(entry.code);
    }
  }
  return found;
}
