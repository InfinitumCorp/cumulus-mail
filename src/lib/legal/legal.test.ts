import assert from "node:assert/strict";
import { test } from "node:test";
import { FIELDS, fill, isReviewed, renderDoc, TEMPLATES, unfilled, valuesFromEnv } from "./ru-templates.ts";
import { legalPageHtml, markdownToHtml } from "./render.ts";

const everyField = Object.fromEntries(FIELDS.map(({ key }) => [`MAIL_LEGAL_RU_${key}`, `value for ${key}`]));

test("every placeholder in both templates has a field the owner is asked for", () => {
  const known = new Set(FIELDS.map((f) => f.key));
  for (const [doc, template] of Object.entries(TEMPLATES)) {
    for (const key of unfilled(template)) {
      assert.ok(known.has(key as never), `${doc} uses {{${key}}} but FIELDS does not list it`);
    }
  }
});

test("an empty environment leaves every placeholder visible and the document a draft", () => {
  for (const doc of ["privacy", "terms"] as const) {
    const rendered = renderDoc(doc, {});
    assert.equal(rendered.draft, true);
    assert.ok(rendered.missing.length > 0);
    assert.match(rendered.markdown, /\{\{[A-Z_]+\}\}/);
  }
});

test("filling every field is still a draft until a human says it was reviewed", () => {
  const filled = renderDoc("privacy", everyField);
  assert.deepEqual(filled.missing, []);
  assert.equal(filled.draft, true, "filled is not the same as approved");
  const reviewed = renderDoc("privacy", { ...everyField, MAIL_LEGAL_RU_REVIEWED: "yes" });
  assert.equal(reviewed.draft, false);
  // Review alone, with fields missing, is still a draft: a half-written policy must never go live.
  assert.equal(renderDoc("privacy", { MAIL_LEGAL_RU_REVIEWED: "yes" }).draft, true);
  assert.equal(isReviewed({ MAIL_LEGAL_RU_REVIEWED: "YES " }), true);
  assert.equal(isReviewed({ MAIL_LEGAL_RU_REVIEWED: "true" }), false);
});

test("the privacy template covers what 152-FZ expects an operator to state", () => {
  const text = TEMPLATES.privacy;
  for (const topic of [
    "Оператор",
    "{{DATA_LOCATION}}", // ст. 18 ч. 5: where the database is
    "{{CROSS_BORDER}}", // ст. 12: cross-border transfer
    "{{CONSENT_TEXT}}", // ст. 9: consent
    "{{RETENTION}}",
    "Права субъекта персональных данных",
    "Роскомнадзор",
    "{{RKN_REGISTRATION}}",
    "{{DPO_CONTACT}}",
  ]) {
    assert.ok(text.includes(topic), `the privacy template should mention ${topic}`);
  }
});

test("fill replaces only what was supplied, and blank values do not count", () => {
  assert.equal(fill("a {{ONE}} b {{TWO}}", { OPERATOR_NAME: "x" } as never), "a {{ONE}} b {{TWO}}");
  assert.equal(fill("{{OPERATOR_NAME}}", { OPERATOR_NAME: "ООО Ромашка" }), "ООО Ромашка");
  assert.equal(fill("{{OPERATOR_NAME}}", { OPERATOR_NAME: "   " }), "{{OPERATOR_NAME}}");
  assert.deepEqual(valuesFromEnv({ MAIL_LEGAL_RU_OPERATOR_NAME: " ООО ", NOT_A_FIELD: "x" }), { OPERATOR_NAME: "ООО" });
});

test("unfilled lists each placeholder once, in order", () => {
  assert.deepEqual(unfilled("{{B}} {{A}} {{B}}"), ["B", "A"]);
  assert.deepEqual(unfilled("nothing here"), []);
});

test("the page says it is a draft, lists what is missing, and asks not to be indexed", () => {
  const html = legalPageHtml(renderDoc("privacy", {}));
  assert.match(html, /ЧЕРНОВИК/);
  assert.match(html, /DRAFT: this template has not been reviewed/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /DATA_LOCATION/);
  assert.match(html, /ст\. 18 ч\. 5/);
  assert.match(html, /<html lang="ru">/);
  assert.equal(/<script/i.test(html), false, "a legal page runs no script");
});

test("a reviewed, filled page carries no draft banner and no noindex", () => {
  const html = legalPageHtml(renderDoc("terms", { ...everyField, MAIL_LEGAL_RU_REVIEWED: "yes" }));
  assert.equal(/ЧЕРНОВИК|noindex/.test(html), false);
  assert.match(html, /Пользовательское соглашение/);
});

test("markdown: headings, tables, lists, bold; placeholders are marked; HTML is escaped", () => {
  assert.equal(markdownToHtml("# Title"), "<h1>Title</h1>");
  assert.equal(markdownToHtml("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(markdownToHtml("**bold** text"), "<p><strong>bold</strong> text</p>");
  assert.match(markdownToHtml("| Цель | Основание |\n|---|---|\n| a | b |"), /<table><thead><tr><th>Цель<\/th>/);
  assert.match(markdownToHtml("see {{DATA_LOCATION}}"), /<mark class="todo">\{\{DATA_LOCATION\}\}<\/mark>/);
  assert.equal(markdownToHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("a wrapped line stays part of its list item, not a stray paragraph", () => {
  assert.equal(markdownToHtml("- one\n  wrapped\n- two"), "<ul><li>one wrapped</li><li>two</li></ul>");
  assert.equal(markdownToHtml("para\nwrapped"), "<p>para wrapped</p>");
  // A blank line still ends the list, so the next paragraph is its own.
  assert.equal(markdownToHtml("- one\n\npara"), "<ul><li>one</li></ul>\n<p>para</p>");
});
