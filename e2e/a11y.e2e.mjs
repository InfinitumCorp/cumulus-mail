// Accessibility gate: axe-core on the main screens. Any **serious or critical** WCAG 2.1 A/AA violation
// fails the run, so a change that introduces one fails CI. Moderate and minor findings are printed, not
// failed, so they stay visible without blocking.
//
// To accept a finding on purpose, add it to ALLOWED with the reason; an empty list is the goal.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** `${screen}:${ruleId}` -> why it is accepted. Keep this empty. */
const ALLOWED = new Map();

let browser;
before(async () => {
  const path = process.env.E2E_CHROMIUM_PATH;
  try {
    browser = await chromium.launch(path ? { executablePath: path } : {});
  } catch (error) {
    const fallback = "/opt/pw-browsers/chromium";
    if (path || !existsSync(fallback)) throw error;
    browser = await chromium.launch({ executablePath: fallback });
  }
});
after(async () => {
  await browser?.close();
});

async function audit(screen, prepare, contextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...contextOptions });
  const page = await context.newPage();
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await prepare(page);
  await page.waitForTimeout(500);
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
  });
  await context.close();
  const blocking = violations.filter((v) => (v.impact === "serious" || v.impact === "critical") && !ALLOWED.has(`${screen}:${v.id}`));
  const other = violations.filter((v) => !blocking.includes(v));
  for (const v of other) console.log(`# a11y ${screen}: ${v.impact} ${v.id} (${v.nodes.length} shown) — not blocking`);
  assert.deepEqual(
    blocking.map((v) => `${v.impact} ${v.id}: ${v.help} at ${v.nodes.join(", ")}`),
    [],
    `${screen}: serious or critical accessibility violations`,
  );
}

test("a11y: inbox list", () => audit("list", async () => {}));

test("a11y: reader", () =>
  audit("reader", async (page) => {
    await page.locator("[data-row-id]").first().click();
  }));

test("a11y: compose", () =>
  audit("compose", async (page) => {
    await page.getByRole("button", { name: "Compose" }).first().click();
    await page.getByRole("button", { name: "Send" }).first().waitFor();
  }));

test("a11y: account dialog", () =>
  audit("account dialog", async (page) => {
    await page.locator("aside button.w-full.border-t").click();
    await page.getByRole("dialog").waitFor();
  }));

test("a11y: mobile shell (390x844)", () => audit("mobile shell", async () => {}, { viewport: { width: 390, height: 844 } }));

test("a11y: Russian interface", () =>
  audit("ru locale", async (page) => {
    await page.getByRole("heading", { name: "Входящие" }).waitFor().catch(() => undefined);
  }, { locale: "ru-RU" }));
