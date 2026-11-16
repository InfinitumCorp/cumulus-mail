import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { catalogsModule, DATE_KEYS, extractAll, extractFrom, isUiText, missingKeys } from "./i18n-extract.mjs";
import { projectRoot } from "./nitro-preset.mjs";
import { initialLocale } from "../src/i18n/initial-locale.js";

const locales = join(projectRoot(), "src/i18n/locales");
const read = (name) => JSON.parse(readFileSync(join(locales, name), "utf8"));

test("every English UI string has a Russian translation (fails on any missing ru key)", () => {
  const en = extractAll();
  const missing = missingKeys(en, read("ru.json"));
  assert.deepEqual(missing, [], `ru.json lacks: ${missing.join(" | ")} - run node scripts/i18n-extract.mjs and translate them`);
});

test("en.json and catalogs.js are current (run node scripts/i18n-extract.mjs after changing UI text)", () => {
  assert.deepEqual(read("en.json"), extractAll());
  assert.equal(readFileSync(join(projectRoot(), "src/i18n/catalogs.js"), "utf8"), catalogsModule(locales));
});

test("ru keeps every {n} placeholder of its English key", () => {
  const ru = read("ru.json");
  for (const key of Object.keys(read("en.json"))) {
    const want = (key.match(/\{\d+\}/g) ?? []).sort();
    const got = (ru[key].match(/\{\d+\}/g) ?? []).sort();
    assert.deepEqual(got, want, key);
  }
});

test("missingKeys reports absent and blank translations", () => {
  assert.deepEqual(missingKeys({ A: "A", B: "B", C: "C" }, { A: "А", C: "  " }), ["B", "C"]);
});

test("extractor: JSX text runs, UI attributes, toasts and labels; no class lists, code or subject prefixes", () => {
  const found = [...extractFrom(
    `const L = { inbox: "Inbox", id: "x-y" };
     function A({ n, busy }) {
       notify(\`\${n} conversations archived.\`);
       const s = subject.startsWith("Fw:") ? subject : \`Fw: \${subject}\`;
       return <div className="flex items-center gap-2">
         <button aria-label="Close composer" title={"Undo send"}>{busy ? "Saving" : "Save"}</button>
         <p>{n} selected</p>
         <input placeholder="Search mail" />
       </div>;
     }`,
    "a.tsx",
  )].sort();
  assert.deepEqual(found, ["{0} conversations archived.", "Close composer", "Inbox", "Save", "Saving", "Search mail", "selected", "Undo send"].sort());
  assert.equal(isUiText("flex items-center gap-2"), false);
  assert.equal(isUiText("true"), false);
});

test("data modules (.ts) contribute only values under UI keys", () => {
  const found = [...extractFrom(`export const F = [{ id: "drafts", label: "Drafts" }, { kind: "Weekly" }];`, "model.ts")];
  assert.deepEqual(found, ["Drafts"]);
});

test("initialLocale: Russian on ru.* hosts, else the browser's languages (Accept-Language), else English", () => {
  const supported = ["en", "ru"];
  assert.equal(initialLocale({ hostname: "ru.mail.cumuluscloud.app", languages: ["en-US"], supported }), "ru");
  assert.equal(initialLocale({ hostname: "RU.mail.cumuluscloud.app", languages: [], supported }), "ru");
  assert.equal(initialLocale({ hostname: "mail.cumuluscloud.app", languages: ["ru-RU", "en"], supported }), "ru");
  assert.equal(initialLocale({ hostname: "mail.cumuluscloud.app", languages: ["de-DE", "en-GB"], supported }), "en");
  assert.equal(initialLocale({ hostname: "mail.cumuluscloud.app", languages: ["fr"], supported }), "en");
});

test("initialLocale: a remembered choice beats the ru.* host", () => {
  const store = new Map([["infinitum.lang", "en"]]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(initialLocale({ hostname: "ru.mail.cumuluscloud.app", languages: ["ru"], supported: ["en", "ru"] }), "en");
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test("extractor: a value handed to a state setter is state, not UI text", () => {
  const found = [...extractFrom(
    `function A({ done }) {
       setFocusNext(done ? "cancel" : "start");
       setMode((done) ? "edit" : "view");
       return <button>{done ? "Saved" : "Save"}</button>;
     }`,
    "a.tsx",
  )].sort();
  assert.deepEqual(found, ["Save", "Saved"]);
});

test("extractor: a lowercase id handed to a call is not UI text; a capitalised label in a call still is", () => {
  const found = [...extractFrom(
    `function A({ spam, ok }) {
       moveToFolder(id, spam ? "quarantine" : "inbox");
       moveToFolder(id, (spam ? "quarantine" : "inbox"));
       notify(ok ? "Moved" : "Not moved");
       return <p>{spam ? "spam" : "clean"}</p>;
     }`,
    "a.tsx",
  )].sort();
  assert.deepEqual(found, ["Moved", "Not moved", "clean", "spam"]);
});

test("extractor: a semicolon in prose is still UI text; a semicolon in code is not", () => {
  assert.equal(isUiText("Anyone with it can read these events, so keep it to yourself; make a new one if it leaks."), true);
  assert.equal(isUiText("Nothing is blocked yet; delete mail or upgrade."), true);
  for (const code of ["a;b", "color: red;", "x = 1; y = 2", "a; 2"]) assert.equal(isUiText(code), false, code);
});

test("extractor: note and reason values in data modules are UI text (sign-in note, bridge status, outbox holds)", () => {
  const found = extractFrom(
    `export const a = { note: "This mailbox trusts that sign-in.", reason: "Held in the outbox. Verify your email.", id: "Not this" };`,
    "lib.ts",
  );
  assert.deepEqual([...found].sort(), ["Held in the outbox. Verify your email.", "This mailbox trusts that sign-in."]);
});

test("dates: every month and weekday the formatters print has a pattern, and ru translates each", () => {
  const ru = JSON.parse(readFileSync(join(projectRoot(), "src/i18n/locales/ru.json"), "utf8"));
  const short = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" });
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const toKey = (text) => text.replace(/^(\w+ )?\d{2} /, (m, day) => `${day ?? ""}{0} `).replace(/, \d{2}:\d{2}$/, ", {1}");
  for (let day = 0; day < 365; day += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + day, 9, 30));
    for (const text of [short.format(date), when.format(date)]) {
      const key = toKey(text);
      assert.ok(DATE_KEYS.includes(key), `${text} → ${key}`);
      assert.ok(ru[key] && !/[A-Za-z]/.test(ru[key].replace(/\{\d\}/g, "")), `ru for ${key}: ${ru[key]}`);
    }
  }
});
