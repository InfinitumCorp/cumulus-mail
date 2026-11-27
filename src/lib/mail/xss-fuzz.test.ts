import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText } from "./mime.ts";
import { classifyLink, extractLinks } from "./safety.ts";

// Mail bodies are shown as React text, never as HTML. These lock in the two pieces that turn
// untrusted mail into what the reader shows: the HTML-to-text step and the clickable links.
const PAYLOADS = [
  `<svg onload=alert(1)><script>alert(1)</script></svg>`,
  `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`,
  `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `<math href="javascript:alert(1)">CLICK</math>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<style>@import url(https://evil.example/x.css);body{background:url("https://evil.example/t")}</style>`,
  `<img srcset="https://evil.example/a.png 1x, javascript:alert(1) 2x" src=x>`,
  `<picture><source srcset="https://evil.example/b.png"><img src=x></picture>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<a href="jav&#x09;ascript:alert(1)">x</a>`,
  `<!--<img src=x onerror=alert(1)>-->`,
  `<scr<script>ipt>alert(1)</script>`,
  `<template><img src=x onerror=alert(1)></template>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<object data="data:text/html,<script>alert(1)</script>"></object>`,
];

test("HTML mail becomes plain text: no markup survives the conversion", () => {
  for (const payload of PAYLOADS) {
    const text = htmlToText(payload);
    // Leftover "<" is harmless as text; a whole tag surviving would mean the conversion missed it.
    assert.doesNotMatch(text, /<[a-z!/][^>]*>/i, payload);
    assert.doesNotMatch(text, /alert\(1\)/, payload);
  }
});

test("only http(s) links become clickable, whatever the mail hides around them", () => {
  const body = [
    ...PAYLOADS,
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "see https://ok.example/path?q=1 and http://plain.example",
  ].join("\n");
  const links = extractLinks(body);
  assert.ok(links.includes("https://ok.example/path?q=1"));
  for (const href of links) {
    assert.match(href, /^https?:\/\//i, href);
    assert.doesNotThrow(() => classifyLink(href));
  }
});
