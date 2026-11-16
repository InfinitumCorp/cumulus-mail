import { createHash, createPublicKey, createSign } from "node:crypto";

/**
 * DKIM signing (RFC 6376), `a=rsa-sha256; c=relaxed/relaxed`.
 * Uses node:crypto, which Workers provide under `nodejs_compat`.
 */
export type DkimOptions = {
  domain: string;
  selector: string;
  /** PKCS#8 or PKCS#1 PEM. */
  privateKeyPem: string;
  /** Header names to sign, in order. Missing headers are skipped. */
  headers?: string[];
  /** Signature timestamp in seconds. Defaults to now. */
  timestamp?: number;
};

export const DEFAULT_SIGNED_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "reply-to",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
];

/** RFC 6376 §3.4.2: lowercase the name, unfold, collapse WSP, trim around the colon and the end. */
export function relaxedHeader(name: string, value: string): string {
  const unfolded = value.replace(/\r\n(?=[ \t])/g, "");
  return `${name.trim().toLowerCase()}:${unfolded.replace(/[ \t]+/g, " ").trim()}`;
}

/** RFC 6376 §3.4.4: collapse WSP, drop trailing WSP per line, drop trailing empty lines, end with CRLF unless empty. */
export function relaxedBody(body: string): string {
  const lines = body.replace(/\r?\n/g, "\r\n").split("\r\n").map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(relaxedBody(body), "utf8").digest("base64");
}

type Header = { name: string; raw: string; value: string };

/** Split a CRLF message into header fields (with folded continuation lines) and the body. */
export function splitMessage(message: string): { headers: Header[]; body: string } {
  const normalized = message.replace(/\r?\n/g, "\r\n");
  const end = normalized.indexOf("\r\n\r\n");
  const head = end >= 0 ? normalized.slice(0, end) : normalized;
  const body = end >= 0 ? normalized.slice(end + 4) : "";
  const headers: Header[] = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && headers.length) {
      const last = headers[headers.length - 1]!;
      last.raw += `\r\n${line}`;
      last.value += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon), raw: line, value: line.slice(colon + 1) });
  }
  return { headers, body };
}

function foldTag(value: string): string {
  // Fold b= every 72 chars so the header stays under the line limit; relaxed canonicalization ignores it.
  return value.replace(/(.{72})/g, "$1\r\n\t").replace(/\r\n\t$/, "");
}

/** Returns the `DKIM-Signature` header line (without trailing CRLF) for the message. */
export function dkimSignatureHeader(message: string, options: DkimOptions): string {
  const { headers, body } = splitMessage(message);
  const wanted = (options.headers ?? DEFAULT_SIGNED_HEADERS).map((name) => name.toLowerCase());
  // RFC 6376 §5.4.2: with repeated names, sign from the bottom up.
  const used = new Map<string, number>();
  const signed: Header[] = [];
  for (const name of wanted) {
    const matches = headers.filter((header) => header.name.trim().toLowerCase() === name);
    const taken = used.get(name) ?? 0;
    const pick = matches[matches.length - 1 - taken];
    if (!pick) continue;
    used.set(name, taken + 1);
    signed.push(pick);
  }
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const tags = [
    "v=1",
    "a=rsa-sha256",
    "c=relaxed/relaxed",
    `d=${options.domain}`,
    `s=${options.selector}`,
    `t=${timestamp}`,
    `h=${signed.map((header) => header.name.trim().toLowerCase()).join(":")}`,
    `bh=${bodyHash(body)}`,
    "b=",
  ].join("; ");
  const canonical =
    signed.map((header) => `${relaxedHeader(header.name, header.value)}\r\n`).join("") +
    relaxedHeader("DKIM-Signature", ` ${tags}`);
  const signature = createSign("RSA-SHA256").update(canonical, "utf8").sign(options.privateKeyPem, "base64");
  return `DKIM-Signature: ${tags}${foldTag(signature)}`;
}

/** Prepend a DKIM-Signature header to a CRLF message. */
export function signMessage(message: string, options: DkimOptions): string {
  return `${dkimSignatureHeader(message, options)}\r\n${message.replace(/\r?\n/g, "\r\n")}`;
}

/**
 * The DNS TXT record to publish at `<selector>._domainkey.<domain>` for a signing key: the public half,
 * as SubjectPublicKeyInfo DER in base64 (RFC 6376 §3.6.1). `npm run dkim:record -- <key.pem>` prints it.
 */
export function dkimDnsRecord(privateKeyPem: string): string {
  const der = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  return `v=DKIM1; k=rsa; p=${Buffer.from(der).toString("base64")}`;
}
