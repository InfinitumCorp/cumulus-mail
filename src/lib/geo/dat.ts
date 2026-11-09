/**
 * Minimal reader for v2ray GeoIPList and GeoSiteList protobuf payloads.
 * No third-party protobuf library: the files only use varints and
 * length-delimited strings, bytes, and nested messages.
 */

export type Cidr = {
  ip: Uint8Array;
  prefix: number;
};

export type GeoIpEntry = {
  countryCode: string;
  cidrs: Cidr[];
  reverseMatch: boolean;
};

export const DomainType = {
  Plain: 0,
  Regex: 1,
  Domain: 2,
  Full: 3,
} as const;

export type DomainType = (typeof DomainType)[keyof typeof DomainType];

export type DomainRule = {
  type: number;
  value: string;
};

export type GeoSiteEntry = {
  code: string;
  domains: DomainRule[];
};

export type GeoDatasets = {
  ip: GeoIpEntry[];
  site: GeoSiteEntry[];
};

type VarintField = { field: number; wire: 0; value: number };
type BytesField = { field: number; wire: 2; bytes: Uint8Array };
type ProtoField = VarintField | BytesField;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0)
    throw new Error("varint must be a non-negative integer");
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte += 128;
    bytes.push(byte);
  } while (rest > 0);
  return Uint8Array.from(bytes);
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint(field * 8 + wire);
}

function delimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([tag(field, 2), encodeVarint(payload.length), payload]);
}

function textField(field: number, value: string): Uint8Array {
  return delimited(field, textEncoder.encode(value));
}

function varintField(field: number, value: number): Uint8Array {
  return concat([tag(field, 0), encodeVarint(value)]);
}

export function encodeCidr(cidr: Cidr): Uint8Array {
  const parts = [delimited(1, cidr.ip)];
  if (cidr.prefix !== 0) parts.push(varintField(2, cidr.prefix));
  return concat(parts);
}

export function encodeGeoIp(entry: GeoIpEntry): Uint8Array {
  const parts = [textField(1, entry.countryCode)];
  for (const cidr of entry.cidrs) parts.push(delimited(2, encodeCidr(cidr)));
  if (entry.reverseMatch) parts.push(varintField(3, 1));
  return concat(parts);
}

export function encodeGeoIpList(entries: GeoIpEntry[]): Uint8Array {
  return concat(entries.map((entry) => delimited(1, encodeGeoIp(entry))));
}

export function encodeAttribute(key: string): Uint8Array {
  return concat([textField(1, key), varintField(2, 1)]);
}

/** A Domain.attribute field. The decoder ignores attributes; fixtures use this to prove that. */
export function encodeDomainAttribute(key: string): Uint8Array {
  return delimited(3, encodeAttribute(key));
}

export function encodeDomain(rule: DomainRule, extra: Uint8Array[] = []): Uint8Array {
  return concat([varintField(1, rule.type), textField(2, rule.value), ...extra]);
}

export function encodeGeoSite(entry: GeoSiteEntry, extras: Uint8Array[][] = []): Uint8Array {
  const parts = [textField(1, entry.code)];
  entry.domains.forEach((domain, index) => {
    parts.push(delimited(2, encodeDomain(domain, extras[index] ?? [])));
  });
  return concat(parts);
}

export function encodeGeoSiteList(
  entries: GeoSiteEntry[],
  extras: Uint8Array[][][] = [],
): Uint8Array {
  return concat(
    entries.map((entry, index) => delimited(1, encodeGeoSite(entry, extras[index] ?? []))),
  );
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset] ?? 0;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("protobuf varint exceeds a safe integer");
      return { value, offset };
    }
    shift += 7;
    if (shift > 63) throw new Error("protobuf varint is too long");
  }
  throw new Error("truncated protobuf varint");
}

export function readFields(bytes: Uint8Array): ProtoField[] {
  const found: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tagValue = readVarint(bytes, offset);
    offset = tagValue.offset;
    const field = Math.floor(tagValue.value / 8);
    const wire = tagValue.value % 8;
    if (field <= 0) throw new Error("invalid protobuf field number");
    if (wire === 0) {
      const body = readVarint(bytes, offset);
      offset = body.offset;
      found.push({ field, wire: 0, value: body.value });
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const next = offset + length.value;
      if (length.value < 0 || next > bytes.length) throw new Error("truncated protobuf field");
      found.push({ field, wire: 2, bytes: bytes.subarray(offset, next) });
      offset = next;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error("truncated protobuf field");
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw new Error("truncated protobuf field");
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return found;
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function decodeCidr(bytes: Uint8Array): Cidr {
  let ip = new Uint8Array();
  let prefix = 0;
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 2) ip = new Uint8Array(field.bytes);
    else if (field.field === 2 && field.wire === 0) prefix = field.value;
  }
  return { ip, prefix };
}

function decodeGeoIp(bytes: Uint8Array): GeoIpEntry {
  let countryCode = "";
  const cidrs: Cidr[] = [];
  let reverseMatch = false;
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 2) countryCode = decodeUtf8(field.bytes);
    else if (field.field === 2 && field.wire === 2) cidrs.push(decodeCidr(field.bytes));
    else if (field.field === 3 && field.wire === 0) reverseMatch = field.value !== 0;
  }
  return { countryCode, cidrs, reverseMatch };
}

export function decodeGeoIpList(bytes: Uint8Array): GeoIpEntry[] {
  const entries: GeoIpEntry[] = [];
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 2) entries.push(decodeGeoIp(field.bytes));
  }
  return entries;
}

function decodeDomain(bytes: Uint8Array): DomainRule {
  let type: number = DomainType.Plain;
  let value = "";
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 0) type = field.value;
    else if (field.field === 2 && field.wire === 2) value = decodeUtf8(field.bytes);
  }
  return { type, value };
}

function decodeGeoSite(bytes: Uint8Array): GeoSiteEntry {
  let code = "";
  const domains: DomainRule[] = [];
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 2) code = decodeUtf8(field.bytes);
    else if (field.field === 2 && field.wire === 2) domains.push(decodeDomain(field.bytes));
  }
  return { code, domains };
}

export function decodeGeoSiteList(bytes: Uint8Array): GeoSiteEntry[] {
  const entries: GeoSiteEntry[] = [];
  for (const field of readFields(bytes)) {
    if (field.field === 1 && field.wire === 2) entries.push(decodeGeoSite(field.bytes));
  }
  return entries;
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? "";
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    out[index] = number;
  }
  return out;
}

function groupsToBytes(groups: number[]): Uint8Array {
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = (group >> 8) & 0xff;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups: number[] = [];
    const parts = side.split(":");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (!v4) return null;
        groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const left = parseSide(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? groupsToBytes(left) : null;
  const right = parseSide(halves[1] ?? "");
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return groupsToBytes([...left, ...Array<number>(missing).fill(0), ...right]);
}

export function parseIp(input: string): Uint8Array | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const zone = raw.indexOf("%");
  const value = zone === -1 ? raw : raw.slice(0, zone);
  if (value.includes(":")) return parseIpv6(value);
  return parseIpv4(value);
}

function ipv4FromMapped(ip: Uint8Array): Uint8Array | null {
  if (ip.length !== 16) return null;
  for (let index = 0; index < 10; index += 1) {
    if (ip[index] !== 0) return null;
  }
  if (ip[10] !== 0xff || ip[11] !== 0xff) return null;
  return ip.subarray(12);
}

export function cidrMatches(ip: Uint8Array, cidr: Cidr): boolean {
  if (ip.length !== cidr.ip.length) return false;
  if (!Number.isInteger(cidr.prefix) || cidr.prefix < 0 || cidr.prefix > ip.length * 8)
    return false;
  const full = Math.floor(cidr.prefix / 8);
  const remainder = cidr.prefix % 8;
  for (let index = 0; index < full; index += 1) {
    if (ip[index] !== cidr.ip[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((ip[full] ?? 0) & mask) === ((cidr.ip[full] ?? 0) & mask);
}

function entryMatches(entry: GeoIpEntry, ip: Uint8Array): boolean {
  const inside = entry.cidrs.some((cidr) => cidrMatches(ip, cidr));
  return entry.reverseMatch ? !inside : inside;
}

/** First two-letter country code that contains the address, otherwise the first matching list name. */
export function lookupCountry(entries: GeoIpEntry[], ip: string): string | null {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  const candidates = [parsed];
  const mapped = ipv4FromMapped(parsed);
  if (mapped) candidates.push(mapped);
  let first: string | null = null;
  for (const candidate of candidates) {
    for (const entry of entries) {
      if (!entryMatches(entry, candidate)) continue;
      if (first === null) first = entry.countryCode;
      if (/^[A-Za-z]{2}$/.test(entry.countryCode)) return entry.countryCode.toUpperCase();
    }
  }
  return first;
}

export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  if (
    !value ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(" ") ||
    value.includes("@")
  ) {
    return "";
  }
  if (value.startsWith("[") && value.includes("]")) return "";
  while (value.endsWith(".")) value = value.slice(0, -1);
  while (value.startsWith(".")) value = value.slice(1);
  return value;
}

const MAX_REGEX_LENGTH = 200;
const regexCache = new Map<string, RegExp | null>();

function compileRule(value: string): RegExp | null {
  if (regexCache.has(value)) return regexCache.get(value) ?? null;
  let compiled: RegExp | null = null;
  if (value.length > 0 && value.length <= MAX_REGEX_LENGTH) {
    try {
      compiled = new RegExp(value);
    } catch {
      compiled = null;
    }
  }
  regexCache.set(value, compiled);
  return compiled;
}

function domainRuleMatches(rule: DomainRule, host: string): boolean {
  if (rule.type === DomainType.Regex) {
    const pattern = rule.value.length <= MAX_REGEX_LENGTH ? compileRule(rule.value) : null;
    return pattern ? pattern.test(host) : false;
  }
  const value = normalizeDomain(rule.value);
  if (!value) return false;
  if (rule.type === DomainType.Full) return host === value;
  if (rule.type === DomainType.Domain) return host === value || host.endsWith(`.${value}`);
  return host.includes(value);
}

/** Category codes (GeoSite.country_code) whose rules match the domain, in file order. */
export function lookupCategories(entries: GeoSiteEntry[], domain: string): string[] {
  const host = normalizeDomain(domain);
  if (!host) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.code)) continue;
    if (!entry.domains.some((rule) => domainRuleMatches(rule, host))) continue;
    seen.add(entry.code);
    found.push(entry.code);
  }
  return found;
}
