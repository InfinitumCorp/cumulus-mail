#!/usr/bin/env node
/**
 * UI strings for the interface translator (src/i18n). The runtime translates the rendered page by
 * exact English text, so the catalog keys are the visible strings in the components:
 *   - JSX text (`<button>Archive</button>`), trimmed and with whitespace collapsed;
 *   - string literals in UI attributes (title, aria-label, placeholder, alt, label);
 *   - each run of JSX text on its own (React renders `{n} selected` as two text nodes, "3" and "selected");
 *   - sentence-like string and template literals in components (toasts, notices, menu labels): they start
 *     with a capital letter and contain a space or end in punctuation; `${x}` becomes `{0}`.
 * Mail content is never extracted (it is rendered from data and marked translate="no").
 *
 *   node scripts/i18n-extract.mjs          write src/i18n/locales/en.json
 *   node scripts/i18n-extract.mjs --check  exit 1 when en.json is out of date
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { isMainModule } from "./with-app-env.mjs";
import { projectRoot } from "./nitro-preset.mjs";

export const UI_ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "label", "aria-description"]);

const LETTER = /\p{L}/u;
/** Looks like UI text, not code: has a letter, no code punctuation, not a class list or identifier. */
export function isUiText(text) {
  if (text === "true" || text === "false") return false;
  if (!text || text.length < 2 || text.length > 300 || !LETTER.test(text)) return false;
  const bare = text.replace(/\{\d+\}/g, "");
  // Code punctuation means code. A semicolon followed by a space and a word is prose
  // ("keep it to yourself; make a new one"), so only other semicolons count.
  if (!LETTER.test(bare) || /[{}<>=`]|;(?!\s\p{L})|=>|\$\{|&&|\|\||\?\?/u.test(bare)) return false;
  if (/^[a-z0-9:_/.\-[\]#%]+( [a-z0-9:_/.\-[\]#%]+)+$/.test(text)) return false; // tailwind class lists
  if (/^[a-z][a-zA-Z0-9]*$/.test(text) && /[A-Z]/.test(text)) return false; // camelCase identifiers
  if (/^(https?:|mailto:|\/)/.test(text)) return false;
  return true;
}

const clean = (text) => text.replace(/\s+/g, " ").trim();

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) && !/\.server\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const SENTENCE = /^(\{0\} )?[\p{Lu}\p{Ll}][^]*(\s|[.!?…:])/u;
const WORDS = /^[\p{Lu}][\p{L} '’-]*$/u;
/** Object keys whose string values are shown in the UI (labels in data modules such as model.ts). */
export const UI_KEYS = new Set(["label", "title", "description", "hint", "empty", "placeholder", "heading", "message", "text", "summary", "note", "reason"]);

/** A word-only string chosen by `?:` in a component (`busy ? "Saving" : "Save"`, `measured ? "used" : …`). */
function isBranchWord(node) {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return false;
  const parent = node.parent;
  if (!parent || !ts.isConditionalExpression(parent) || parent.condition === node) return false;
  // A value handed to a React state setter (`setFocusNext(done ? "cancel" : "start")`) is state, not text
  // on screen. Walk out through parentheses to the call, if any.
  let outer = parent.parent;
  while (outer && ts.isParenthesizedExpression(outer)) outer = outer.parent;
  if (outer && ts.isCallExpression(outer) && /^set[A-Z]/.test(outer.expression.getText())) return false;
  // Nor is a single lowercase token handed to any other call (`moveToFolder(id, spam ? "quarantine" :
  // "inbox")`): that is an id. Capitalised words and phrases in a call are still UI text.
  if (outer && ts.isCallExpression(outer) && outer.arguments.some((a) => a === parent || (ts.isParenthesizedExpression(a) && a.expression === parent)) && /^[a-z][a-z0-9_-]*$/.test(node.text)) return false;
  return /^\p{L}[\p{L} '’.…-]*$/u.test(node.text) && !/^[a-z]+(-[a-z]+)+$/.test(node.text);
}

/** A capitalised label as an object property value: any key in components, UI keys elsewhere. */
function isLabelValue(node, sf, tsx) {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return false;
  const parent = node.parent;
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return false;
  const key = parent.name.getText(sf).replace(/^["']|["']$/g, "");
  if (!tsx && !UI_KEYS.has(key)) return false;
  return WORDS.test(node.text) || (UI_KEYS.has(key) && SENTENCE.test(clean(node.text)) && /^\p{Lu}/u.test(node.text));
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  let out = node.head.text;
  node.templateSpans.forEach((span, i) => {
    out += `{${i}}${span.literal.text}`;
  });
  return out;
}

/** A capitalised phrase in a string or template literal that is not an import, a key or a type. */
function isSentenceLiteral(node, sf) {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) return false;
  const parent = node.parent;
  if (!parent || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isElementAccessExpression(parent) || ts.isJsxAttribute(parent)) return false;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(sf);
    if (/^(console\.|require|import|fetch|new URL|.*\.(get|set|has|delete|querySelector\w*|getElementById|addEventListener|startsWith|endsWith|includes|split|replace|match|test)$)/.test(callee)) return false;
  }
  if (ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText(sf))) return true;
  const text = clean(literalText(node));
  if (/^(Re|Fw|Fwd): ?(\{0\})?$/.test(text)) return false; // subject prefixes are mail content
  const startsUpper = /^(\{0\} )?\p{Lu}/u.test(text);
  const fromVar = /^\{0\} \p{Ll}/u.test(text) && /\s/.test(text.slice(4));
  return (startsUpper || fromVar) && SENTENCE.test(text) && text.replace(/\{\d+\}/g, "").trim().length > 1;
}

/** Strings from one TSX source. */
export function extractFrom(source, fileName = "file.tsx") {
  const tsx = fileName.endsWith(".tsx");
  const found = new Set();
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const add = (text) => {
    const value = clean(text);
    if (isUiText(value)) found.add(value);
  };
  const visit = (node) => {
    // React renders each run of JSX text as its own DOM text node, and the runtime translates text
    // nodes one by one: `Save {name} to contacts` reaches it as "Save" and "to contacts".
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) add(node.text);
    if (isLabelValue(node, sf, tsx) || (tsx && isBranchWord(node))) add(node.text);
    else if (tsx && isSentenceLiteral(node, sf)) add(literalText(node));
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (UI_ATTRS.has(name)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) add(init.text);
        else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) add(init.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Dates. src/lib/mail/logic.ts formats them in English on the server and in the browser alike (so the
 * hydrated page matches the server's), as "03 Nov" (formatShort) and "Tue 03 Nov, 16:48" (formatWhen).
 * These patterns let a catalog translate them like any other text. Both "Sep" and "Sept": ICU versions differ.
 */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DATE_KEYS = [
  ...MONTHS.map((month) => `{0} ${month}`),
  ...WEEKDAYS.flatMap((day) => MONTHS.map((month) => `${day} {0} ${month}, {1}`)),
];

/** Strings the runtime asks for by name (src/i18n/i18n.js labels the language menu "Language"), and the date patterns. */
export const RUNTIME_KEYS = ["Language", "{0} / {1} GB", ...DATE_KEYS];

export function extractAll(root = projectRoot()) {
  const all = new Set(RUNTIME_KEYS);
  for (const file of walkFiles(join(root, "src")).filter((f) => !f.includes("/i18n/") && !f.endsWith("routeTree.gen.ts"))) {
    for (const text of extractFrom(readFileSync(file, "utf8"), relative(root, file))) all.add(text);
  }
  return Object.fromEntries([...all].sort((a, b) => a.localeCompare(b, "en")).map((k) => [k, k]));
}

/** catalogs.js for the runtime: every locales/<code>.json, English first. */
export function catalogsModule(localesDir) {
  const codes = readdirSync(localesDir)
    .filter((name) => /^[a-z]{2}\.json$/.test(name))
    .map((name) => name.slice(0, 2))
    .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)));
  const catalogs = Object.fromEntries(codes.map((code) => [code, JSON.parse(readFileSync(join(localesDir, `${code}.json`), "utf8"))]));
  return `// Generated by scripts/i18n-extract.mjs from src/i18n/locales/*.json. Do not edit; edit the JSON and re-run.\nexport default ${JSON.stringify(catalogs, null, 1)};\n`;
}

/** Keys in English that a locale lacks (an empty list means the locale is complete). */
export function missingKeys(en, other) {
  return Object.keys(en).filter((key) => typeof other[key] !== "string" || !other[key].trim());
}

if (isMainModule(import.meta.url)) {
  const localesDir = join(projectRoot(), "src/i18n/locales");
  const catalogsPath = join(projectRoot(), "src/i18n/catalogs.js");
  const path = join(localesDir, "en.json");
  const next = `${JSON.stringify(extractAll(), null, 1)}\n`;
  if (process.argv.includes("--check")) {
    const problems = [];
    if (readFileSync(path, "utf8") !== next) problems.push("en.json is out of date with the components");
    if (readFileSync(catalogsPath, "utf8") !== catalogsModule(localesDir)) problems.push("catalogs.js is out of date with locales/*.json");
    const en = JSON.parse(next);
    for (const name of readdirSync(localesDir).filter((n) => /^[a-z]{2}\.json$/.test(n) && n !== "en.json")) {
      const missing = missingKeys(en, JSON.parse(readFileSync(join(localesDir, name), "utf8")));
      if (missing.length) problems.push(`${name} lacks ${missing.length} key(s): ${missing.slice(0, 5).join(" | ")}`);
    }
    if (problems.length) {
      for (const p of problems) console.error(`[i18n] ${p}`);
      console.error("[i18n] run node scripts/i18n-extract.mjs, translate the new keys, run it again");
      process.exit(1);
    }
    console.log("[i18n] catalogs up to date and complete");
  } else {
    writeFileSync(path, next);
    writeFileSync(join(localesDir, ".en-snapshot.json"), next);
    writeFileSync(catalogsPath, catalogsModule(localesDir));
    console.log(`[i18n] ${Object.keys(JSON.parse(next)).length} strings -> src/i18n/locales/en.json, catalogs.js`);
  }
}
