// Launch accessibility pass: what a11y.e2e.mjs and a11y-new-screens.e2e.mjs do not cover yet.
// - The smallest common phone width, 360 px: the main screens in English and Russian pass axe (serious
//   and critical WCAG 2.1 A/AA fail) and nothing scrolls sideways.
// - The 404 page in English and Russian, and the password-protected message page (/p/<token>).
// - The keyboard alone: Tab reaches Compose, Enter opens it, focus lands in the form, and the fields
//   take typed text in order.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const PHONE = { width: 360, height: 740 };

let browser;
before(async () => {
  const path = process.env.E2E_CHROMIUM_PATH;
  try {
    browser = await chromium.launch(path ? { executablePath: path } : {});
  } catch (error) {
    const fallback = "/opt/pw-browsers/chromium";
    if (!existsSync(fallback)) throw error;
    browser = await chromium.launch({ executablePath: fallback });
  }
});
after(async () => {
  await browser?.close();
});

async function axe(page, screen) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  });
  for (const v of violations.filter((v) => v.impact !== "serious" && v.impact !== "critical")) {
    console.log(`# a11y ${screen}: ${v.impact} ${v.id} — not blocking`);
  }
  assert.deepEqual(
    violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.help} at ${v.nodes.join(", ")}`),
    [],
    `${screen}: serious or critical accessibility violations`,
  );
}

async function noSidewaysScroll(page, screen) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width + 1, `${screen}: the page is ${scroll} px wide in a ${width} px window`);
}

async function openApp(options = {}) {
  const context = await browser.newContext({ viewport: PHONE, ...options });
  const page = await context.newPage();
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page };
}

for (const [label, options] of [
  ["English", {}],
  ["Russian", { locale: "ru-RU" }],
]) {
  test(`360 px (${label}): inbox, reader and compose pass axe and nothing scrolls sideways`, async () => {
    const { context, page } = await openApp(options);
    try {
      await axe(page, `${label} 360 inbox`);
      await noSidewaysScroll(page, `${label} 360 inbox`);

      await page.locator("[data-row-id]").first().click();
      await page.waitForTimeout(400);
      await axe(page, `${label} 360 reader`);
      await noSidewaysScroll(page, `${label} 360 reader`);

      await page.goto(URL_BASE, { waitUntil: "networkidle" });
      await page.locator("[data-row-id]").first().waitFor();
      const compose = page.getByRole("button", { name: label === "English" ? "Compose" : /Написать|Новое письмо/ }).first();
      await compose.click();
      await page.getByRole("button", { name: label === "English" ? "Send" : /Отправить/ }).first().waitFor();
      await axe(page, `${label} 360 compose`);
      await noSidewaysScroll(page, `${label} 360 compose`);
    } finally {
      await context.close();
    }
  });

  test(`404 page (${label}) passes axe, has a heading and a way back`, async () => {
    const context = await browser.newContext({ viewport: PHONE, ...options });
    const page = await context.newPage();
    try {
      const response = await page.goto(new URL("/no-such-page-here", URL_BASE).toString(), { waitUntil: "networkidle" });
      assert.equal(response?.status(), 404);
      assert.ok(await page.getByRole("heading").first().isVisible(), "a heading names the page");
      assert.ok((await page.getByRole("link").count()) > 0, "a link leads back");
      await axe(page, `${label} 404`);
      await noSidewaysScroll(page, `${label} 404`);
    } finally {
      await context.close();
    }
  });
}

test("protected message page (/p/<token>): passes axe at 360 px, the password field has a name", async () => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  try {
    await page.goto(new URL(`/p/${"0".repeat(48)}`, URL_BASE).toString(), { waitUntil: "networkidle" });
    const password = page.locator('input[type="password"]');
    await password.waitFor();
    const name = await password.evaluate((el) => el.labels?.[0]?.textContent?.trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || "");
    assert.ok(name, "the password field has an accessible name");
    await axe(page, "protected message");
    await noSidewaysScroll(page, "protected message");
  } finally {
    await context.close();
  }
});

test("keyboard only: Tab reaches Compose, Enter opens it, focus is in the form and the fields take text", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.tagName === "BUTTON" && /compose/i.test(el.textContent ?? "") ;
      });
    }
    assert.ok(reached, "Compose is reachable with Tab within 60 presses");
    const visible = await page.evaluate(() => {
      const el = document.activeElement;
      const style = el ? getComputedStyle(el) : null;
      return Boolean(style && (style.outlineStyle !== "none" || style.boxShadow !== "none"));
    });
    assert.ok(visible, "the focused Compose button shows a focus indicator");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Send" }).first().waitFor();
    // Focus moves into the compose form on open (or one Tab gets it there).
    let inForm = await page.evaluate(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "") || document.activeElement?.isContentEditable === true);
    if (!inForm) {
      await page.keyboard.press("Tab");
      inForm = await page.evaluate(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "") || document.activeElement?.isContentEditable === true);
    }
    assert.ok(inForm, "focus is in the compose form");
    await page.keyboard.type("bea@cumuluscloud.app");
    const typed = await page.evaluate(() => (document.activeElement && "value" in document.activeElement ? document.activeElement.value : document.activeElement?.textContent) ?? "");
    assert.match(String(typed), /bea@cumuluscloud\.app/, "the focused field took the typed address");
  } finally {
    await context.close();
  }
});
