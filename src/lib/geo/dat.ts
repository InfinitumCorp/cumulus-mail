/**
 * Minimal reader for v2ray GeoIPList and GeoSiteList protobufs.
 * No third-party protobuf library. Unknown fields are skipped.
 */

export type Cidr = { ip: Uint8Array; prefix: number };

export type GeoIpEntry = {
  country: string;
  cidrs: Cidr[];
  reverse: boolean;
};

export type GeoIpList = { entries: GeoIpEntry[] };

export type DomainKind = "plain" | "regex" | "domain" | "full";

export type GeoSiteList = {
  full: Map<string, string[]>;
  domain: Map<string, string[]>;
  plain: Array<{ value: string; category: string }>;
  regex: Array<{ source: string; category: string; compiled?: RegExp | null }>;
};

const text = new TextDecoder();
const utf8 = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

function key(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

function fieldBytes(field: number, bytes: Uint8Array): Uint8Array {
  return concat([key(field, 2), encodeVarint(bytes.byteLength), bytes]);
}

function fieldString(field: number, value: string): Uint8Array {
  return fieldBytes(field, utf8.encode(value));
}

function fieldVarint(field: number, value: number): Uint8Array {
  return concat([key(field, 0), encodeVarint(value)]);
}

function readVarint(buf: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buf.length && shift <= 28) {
    const byte = buf[cursor]!;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: cursor };
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

type Field = { field: number; bytes?: Uint8Array; value?: number };

function readFields(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (field === 0) throw new Error("invalid protobuf field");
    if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const end = offset + len.value;
      if (len.value < 0 || end > buf.length) throw new Error("truncated protobuf");
      fields.push({ field, bytes: buf.subarray(offset, end) });
      offset = end;
    } else if (wire === 0) {
      const body = readVarint(buf, offset);
      offset = body.offset;
      fields.push({ field, value: body.value });
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated protobuf");
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated protobuf");
      offset += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function asString(bytes: Uint8Array | undefined): string {
  return bytes ? text.decode(bytes) : "";
}

function parseCidr(buf: Uint8Array): Cidr {
  let ip = new Uint8Array();
  let prefix = 0;
  for (const field of readFields(buf)) {
    if (field.field === 1 && field.bytes) ip = new Uint8Array(field.bytes);
    if (field.field === 2 && field.value !== undefined) prefix = field.value;
  }
  return { ip, prefix };
}

function parseGeoIp(buf: Uint8Array): GeoIpEntry {
  let country = "";
  const cidrs: Cidr[] = [];
  let reverse = false;
  for (const field of readFields(buf)) {
    if (field.field === 1 && field.bytes) country = asString(field.bytes);
    if (field.field === 2 && field.bytes) cidrs.push(parseCidr(field.bytes));
    if (field.field === 3 && field.value) reverse = true;
  }
  return { country, cidrs, reverse };
}

export function parseGeoIpList(buf: Uint8Array): GeoIpList {
  const entries: GeoIpEntry[] = [];
  for (const field of readFields(buf)) {
    if (field.field === 1 && field.bytes) entries.push(parseGeoIp(field.bytes));
  }
  return { entries };
}

const KINDS: DomainKind[] = ["plain", "regex", "domain", "full"];

function addCategory(map: Map<string, string[]>, keyName: string, category: string) {
  const list = map.get(keyName);
  if (list) {
    if (!list.includes(category)) list.push(category);
    return;
  }
  map.set(keyName, [category]);
}

function parseGeoSite(buf: Uint8Array, list: GeoSiteList) {
  let category = "";
  const domains: Array<{ kind: DomainKind; value: string }> = [];
  for (const field of readFields(buf)) {
    if (field.field === 1 && field.bytes) category = asString(field.bytes);
    if (field.field === 2 && field.bytes) {
      let kind: DomainKind = "plain";
      let value = "";
      for (const inner of readFields(field.bytes)) {
        if (inner.field === 1 && inner.value !== undefined) kind = KINDS[inner.value] ?? "plain";
        if (inner.field === 2 && inner.bytes) value = asString(inner.bytes);
      }
      domains.push({ kind, value });
    }
  }
  if (!category) return;
  for (const domain of domains) {
    const value = domain.value.trim().toLowerCase();
    if (!value) continue;
    if (domain.kind === "full") addCategory(list.full, value, category);
    else if (domain.kind === "domain") addCategory(list.domain, value, category);
    else if (domain.kind === "regex") list.regex.push({ source: domain.value, category });
    else list.plain.push({ value, category });
  }
}

export function parseGeoSiteList(buf: Uint8Array): GeoSiteList {
  const list: GeoSiteList = { full: new Map(), domain: new Map(), plain: [], regex: [] };
  for (const field of readFields(buf)) {
    if (field.field === 1 && field.bytes) parseGeoSite(field.bytes, list);
  }
  return list;
}

export function encodeGeoIpList(entries: GeoIpEntry[]): Uint8Array {
  return concat(
    entries.map((entry) => {
      const cidrs = entry.cidrs.map((cidr) => {
        const parts = [fieldBytes(1, cidr.ip)];
        if (cidr.prefix) parts.push(fieldVarint(2, cidr.prefix));
        return fieldBytes(2, concat(parts));
      });
      const parts = [fieldString(1, entry.country), ...cidrs];
      if (entry.reverse) parts.push(fieldVarint(3, 1));
      return fieldBytes(1, concat(parts));
    }),
  );
}

const KIND_ID: Record<DomainKind, number> = { plain: 0, regex: 1, domain: 2, full: 3 };

export function encodeGeoSiteList(
  sites: Array<{ category: string; domains: Array<{ kind: DomainKind; value: string }> }>,
): Uint8Array {
  return concat(
    sites.map((site) => {
      const domains = site.domains.map((domain) => {
        const parts = [fieldVarint(1, KIND_ID[domain.kind]), fieldString(2, domain.value)];
        return fieldBytes(2, concat(parts));
      });
      return fieldBytes(1, concat([fieldString(1, site.category), ...domains]));
    }),
  );
}

export function parseIp(input: string): Uint8Array | null {
  const raw = input.trim().toLowerCase().split("%")[0] ?? "";
  if (!raw) return null;
  if (raw.includes(":")) return parseIpv6(raw);
  return parseIpv4(raw);
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

function parseIpv6(raw: string): Uint8Array | null {
  let head = raw;
  let tail: Uint8Array | null = null;
  if (raw.includes(".")) {
    const colon = raw.lastIndexOf(":");
    if (colon < 0) return null;
    tail = parseIpv4(raw.slice(colon + 1));
    if (!tail) return null;
    head = raw.slice(0, colon);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => part === "") || right.some((part) => part === "")) return null;
  const groupsNeeded = tail ? 6 : 8;
  if (halves.length === 1) {
    if (left.length !== groupsNeeded) return null;
  } else if (left.length + right.length > groupsNeeded) return null;
  const missing = groupsNeeded - left.length - right.length;
  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (groups.length !== groupsNeeded) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = Number.parseInt(group, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

function cidrContains(network: Uint8Array, prefix: number, ip: Uint8Array): boolean {
  if (network.byteLength === 0 || network.byteLength !== ip.byteLength) return false;
  const bits = network.byteLength * 8;
  if (prefix < 0 || prefix > bits) return false;
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  for (let i = 0; i < full; i += 1) if (network[i] !== ip[i]) return false;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (network[full]! & mask) === (ip[full]! & mask);
}

function entryMatches(entry: GeoIpEntry, ip: Uint8Array): boolean {
  const hit = entry.cidrs.some((cidr) => cidrContains(cidr.ip, cidr.prefix, ip));
  return entry.reverse ? !hit : hit;
}

/** First matching country code, or null when the address is not listed. */
export function lookupCountry(list: GeoIpList, ip: string): string | null {
  const addr = parseIp(ip);
  if (!addr) return null;
  for (const entry of list.entries) {
    if (entryMatches(entry, addr)) return entry.country || null;
  }
  return null;
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function pushAll(target: Set<string>, categories: string[] | undefined) {
  if (!categories) return;
  for (const category of categories) target.add(category);
}

function regexHits(rule: GeoSiteList["regex"][number], domain: string): boolean {
  if (rule.source.length > 512) return false;
  if (rule.compiled === undefined) {
    try {
      rule.compiled = new RegExp(rule.source);
    } catch {
      rule.compiled = null;
    }
  }
  if (!rule.compiled) return false;
  rule.compiled.lastIndex = 0;
  return rule.compiled.test(domain);
}

/** Categories whose domain rules match this host. A host may be in more than one. */
export function lookupCategories(list: GeoSiteList, host: string): string[] {
  const domain = normalizeDomain(host);
  if (!domain || domain.includes("/") || /\s/.test(domain)) return [];
  const found = new Set<string>();
  pushAll(found, list.full.get(domain));
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i += 1) {
    pushAll(found, list.domain.get(labels.slice(i).join(".")));
  }
  for (const rule of list.plain) {
    if (rule.value && domain.includes(rule.value)) found.add(rule.category);
  }
  for (const rule of list.regex) {
    if (regexHits(rule, domain)) found.add(rule.category);
  }
  return [...found];
}
