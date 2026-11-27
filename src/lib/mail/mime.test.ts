/**
 * MIME edge cases seen in real inbound mail (src/lib/mail/mime.ts). Russian mail in particular still
 * arrives in windows-1251 and KOI8-R, with RFC 2047 names and RFC 2231 file names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMime } from "./mime.ts";

const CRLF = "\r\n";
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const encode = (text: string, charset: string) => {
  // Node can decode these but not encode them; build the bytes from a reverse table.
  const decoder = new TextDecoder(charset);
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) table.set(decoder.decode(Uint8Array.of(byte)), byte);
  return Uint8Array.from([...text].map((c) => table.get(c) ?? 63));
};
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ascii = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("RFC 2047: encoded subject and From display name, B and Q, UTF-8 and windows-1251, adjacent words joined", () => {
  const name1251 = b64(encode("Анна Петрова", "windows-1251"));
  const raw = [
    `From: =?UTF-8?B?${b64(ascii("Иван Иванов"))}?= <ivan@example.ru>`,
    `To: "=?windows-1251?B?${name1251}?=" <anna@cumuluscloud.app>, plain@example.com`,
    `Subject: =?UTF-8?Q?=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82?= =?UTF-8?Q?_=D0=BC=D0=B8=D1=80?=`,
    "",
    "body",
  ].join(CRLF);
  const parsed = parseMime(raw);
  assert.equal(parsed.subject, "Привет мир");
  assert.deepEqual(parsed.from, { name: "Иван Иванов", email: "ivan@example.ru" });
  assert.equal(parsed.to[0]?.name, "Анна Петрова");
  assert.equal(parsed.to[1]?.email, "plain@example.com");
});

test("non-UTF-8 bodies: windows-1251 8bit, KOI8-R quoted-printable, ISO-8859-1 base64", () => {
  for (const [charset, encoding, text] of [
    ["windows-1251", "8bit", "Добрый день! Счёт во вложении."],
    ["koi8-r", "quoted-printable", "Совещание в пятницу"],
    ["iso-8859-1", "base64", "Grüße aus Köln, café"],
  ] as const) {
    const bytes = encode(text, charset);
    const body =
      encoding === "base64"
        ? ascii(b64(bytes))
        : encoding === "quoted-printable"
          ? ascii([...bytes].map((b) => (b < 128 && b !== 61 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`)).join(""))
          : bytes;
    const raw = join(
      ascii([`From: x@example.ru`, `Subject: t`, `Content-Type: text/plain; charset="${charset}"`, `Content-Transfer-Encoding: ${encoding}`, "", ""].join(CRLF)),
      body,
    );
    assert.equal(parseMime(raw).text, text, `${charset} ${encoding}`);
  }
});

test("an unknown charset falls back to UTF-8 instead of failing the message", () => {
  const raw = ["From: x@example.com", "Content-Type: text/plain; charset=x-made-up", "", "hello"].join(CRLF);
  assert.equal(parseMime(raw).text, "hello");
});

test("RFC 2231 file names (filename*=UTF-8''..., with continuations) and RFC 2047 file names", () => {
  const pct = encodeURIComponent("Договор №5.pdf");
  const raw = [
    "From: x@example.ru",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "see attached",
    "--b1",
    "Content-Type: application/pdf",
    `Content-Disposition: attachment; filename*=UTF-8''${pct}`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(ascii("%PDF-1")),
    "--b1",
    "Content-Type: application/octet-stream",
    `Content-Disposition: attachment; filename*0*=UTF-8''${encodeURIComponent("Отчёт за ")}; filename*1*=${encodeURIComponent("ноябрь.xlsx")}`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(ascii("PK")),
    "--b1",
    `Content-Type: image/png; name="=?UTF-8?B?${b64(ascii("Схема.png"))}?="`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(Uint8Array.of(137, 80, 78, 71)),
    "--b1--",
    "",
  ].join(CRLF);
  const names = parseMime(raw).attachments.map((a) => a.name);
  assert.deepEqual(names, ["Договор №5.pdf", "Отчёт за ноябрь.xlsx", "Схема.png"]);
});

test("the multipart preamble and epilogue are not the message", () => {
  const raw = [
    "From: x@example.com",
    'Content-Type: multipart/alternative; boundary="sep"',
    "",
    "This is a multi-part message in MIME format.",
    "",
    "If you can read this, your mail client is too old.",
    "--sep",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The real text.",
    "--sep",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>The real text.</p>",
    "--sep--",
    "",
    "epilogue that is not a part",
  ].join(CRLF);
  const parsed = parseMime(raw);
  assert.equal(parsed.text, "The real text.");
  assert.equal(parsed.attachments.length, 0);
});

test("HTML-only mail: styles, scripts and head are dropped, entities decoded, blocks become lines", () => {
  const raw = [
    "From: news@shop.example",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><title>Sale</title><style>.x{color:red}</style></head><body>",
    "<script>track()</script><p>Tom &amp; Jerry&nbsp;&mdash; 50&#37; off</p><p>Ends &quot;soon&quot;<br>Unsubscribe</p>",
    "</body></html>",
  ].join(CRLF);
  const text = parseMime(raw).text;
  assert.doesNotMatch(text, /color:red|track\(\)|Sale/);
  assert.match(text, /Tom & Jerry\u00a0— 50% off/);
  assert.match(text, /Ends "soon"\nUnsubscribe/);
});

test("inline images in multipart/related are kept as attachments; the text part is the body", () => {
  const raw = [
    "From: x@example.com",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Logo: <img src="cid:logo@x"></p>',
    "--rel",
    "Content-Type: image/png",
    "Content-ID: <logo@x>",
    "Content-Disposition: inline",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Uint8Array.of(137, 80, 78, 71, 13, 10)),
    "--rel--",
  ].join(CRLF);
  const parsed = parseMime(raw);
  assert.equal(parsed.text, "Logo:");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.contentType, "image/png");
  assert.deepEqual([...parsed.attachments[0]!.bytes], [137, 80, 78, 71, 13, 10]);
});

test("binary 8bit parts keep their exact bytes", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 13 && b !== 10);
  const raw = join(
    ascii(["From: x@example.com", 'Content-Type: multipart/mixed; boundary="m"', "", "--m", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="blob.bin"', "Content-Transfer-Encoding: 8bit", "", ""].join(CRLF)),
    bytes,
    ascii(`${CRLF}--m--${CRLF}`),
  );
  assert.deepEqual([...parseMime(raw).attachments[0]!.bytes], [...bytes]);
});

test("malformed input never throws: bad base64, missing boundary, no blank line, truncated multipart, empty", () => {
  const cases = [
    ["From: x@example.com", "Content-Transfer-Encoding: base64", "", "SGVsbG8*@@=!!gd29ybGQ"].join(CRLF),
    ["From: x@example.com", "Content-Type: multipart/mixed", "", "--x", "hi"].join(CRLF),
    "From: x@example.com",
    ["From: x@example.com", 'Content-Type: multipart/mixed; boundary="t"', "", "--t", "Content-Type: text/plain", "", "cut off here"].join(CRLF),
    "",
    latin1("ÿþ\u0000garbage"),
  ];
  for (const raw of cases) assert.doesNotThrow(() => parseMime(raw), String(raw).slice(0, 40));
  assert.equal(parseMime(cases[3]!).text, "cut off here");
});

test("a large attachment near the cap (20 MB) parses with its bytes intact", () => {
  const size = 20 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = i % 251;
  const encoded = Buffer.from(bytes).toString("base64").replace(/.{76}/g, `$&${CRLF}`);
  const raw = join(
    ascii(["From: x@example.com", 'Content-Type: multipart/mixed; boundary="big"', "", "--big", "Content-Type: text/plain", "", "big file", "--big", "Content-Type: application/zip", 'Content-Disposition: attachment; filename="big.zip"', "Content-Transfer-Encoding: base64", "", ""].join(CRLF)),
    ascii(encoded),
    ascii(`${CRLF}--big--${CRLF}`),
  );
  const started = Date.now();
  const parsed = parseMime(raw);
  const file = parsed.attachments[0]!;
  assert.equal(file.bytes.length, size);
  assert.equal(file.bytes[4096 * 7], (4096 * 7) % 251);
  assert.ok(Date.now() - started < 10_000, `parsed in ${Date.now() - started} ms`);
});

test("RFC 6532: raw UTF-8 in headers (no encoded words) is read as UTF-8", () => {
  const raw = join(ascii("From: =?x?= <a@b.c>\r\nSubject: "), new TextEncoder().encode("Отчёт готов"), ascii("\r\n\r\nok"));
  assert.equal(parseMime(raw).subject, "Отчёт готов");
});

test("windows-1251 and KOI8-R decode from the built-in tables when the runtime's TextDecoder lacks them", async () => {
  const { decodeCharset } = await import("./mime.ts");
  const Native = globalThis.TextDecoder;
  const text = "Ёлка, щука, ЪЬЭ — №1";
  const koiText = "Ёлка, щука, ЪЬЭ: сводка";
  const cp1251 = encode(text, "windows-1251");
  const koi8 = encode(koiText, "koi8-r");
  class Limited extends Native {
    constructor(label = "utf-8", options?: TextDecoderOptions) {
      if (!/^utf-?8$/i.test(label)) throw new RangeError(`unsupported: ${label}`);
      super(label, options);
    }
  }
  globalThis.TextDecoder = Limited as typeof TextDecoder;
  try {
    assert.equal(decodeCharset(cp1251, "windows-1251"), text);
    assert.equal(decodeCharset(cp1251, "CP1251"), text);
    assert.equal(decodeCharset(koi8, "koi8-r"), koiText);
    assert.equal(decodeCharset(new TextEncoder().encode("ok"), "iso-2022-jp"), "ok", "anything else falls back to UTF-8");
  } finally {
    globalThis.TextDecoder = Native;
  }
});
