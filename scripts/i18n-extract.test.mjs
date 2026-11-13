import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { catalogsModule, extractAll, extractFrom, isUiText, missingKeys } from "./i18n-extract.mjs";
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
