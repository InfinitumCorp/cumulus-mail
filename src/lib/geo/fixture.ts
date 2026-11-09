/** Tiny protobuf encoder for synthetic GeoIPList and GeoSiteList fixtures. */

function varint(n: number): number[] {
  const out: number[] = [];
  let value = n >>> 0;
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function bytesField(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function varField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)];
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

export function cidr(ip: number[], prefix: number): number[] {
  return [...bytesField(1, ip), ...varField(2, prefix)];
}

export function geoipEntry(code: string, cidrs: number[][], reverse = false): number[] {
  return [
    ...bytesField(1, utf8(code)),
    ...cidrs.flatMap((item) => bytesField(2, item)),
    ...(reverse ? varField(3, 1) : []),
  ];
}

export function geoipList(entries: number[][]): Uint8Array {
  return Uint8Array.from(entries.flatMap((entry) => bytesField(1, entry)));
}

export function domainRule(type: number, value: string, extra: number[] = []): number[] {
  return [...(type === 0 ? [] : varField(1, type)), ...bytesField(2, utf8(value)), ...extra];
}

export function skippedFixed32(field: number): number[] {
  return [...tag(field, 5), 0, 0, 0, 0];
}

export function geositeEntry(code: string, domains: number[][]): number[] {
  return [...bytesField(1, utf8(code)), ...domains.flatMap((domain) => bytesField(2, domain))];
}

export function geositeList(entries: number[][]): Uint8Array {
  return Uint8Array.from(entries.flatMap((entry) => bytesField(1, entry)));
}
