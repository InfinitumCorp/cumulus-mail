// Dark mode: follows the device by default, Settings → Appearance overrides it (and survives a reload),
// and the main screens have no serious WCAG 2.1 AA violations (contrast included) in the dark theme.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const DARK_BG = "rgb(15, 20, 25)";
const LIGHT_BG = "rgb(255, 255, 255)";

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

async function open(colorScheme, locale = "en-US") {
  const context = await browser.newContext({ colorScheme, locale, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page, errors };
}

const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function axeBlocking(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} at ${v.nodes[0]?.target.join(" ")}`);
  });
}

async function openSettings(page) {
  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return dialog;
}

async function choose(page, label) {
  const dialog = await openSettings(page);
  const group = dialog.getByRole("radiogroup", { name: /Appearance|Оформление/ });
  await group.getByRole("radio", { name: label }).check();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
}

test("theme: a dark device gets the dark theme, and list, reader, compose and settings pass axe in it", async () => {
  const { context, page, errors } = await open("dark");
  assert.equal(await background(page), DARK_BG);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "dark");
  assert.deepEqual(await axeBlocking(page), [], "list");

  await page.locator("[data-row-id]").first().click();
  await page.getByRole("button", { name: "Reply", exact: true }).waitFor();
  assert.deepEqual(await axeBlocking(page), [], "reader");

  await page.getByRole("button", { name: "Compose" }).first().click();
  const compose = page.getByRole("dialog", { name: "Compose" });
  await compose.waitFor();
  assert.deepEqual(await axeBlocking(page), [], "compose");
  await compose.getByRole("button", { name: "Close composer" }).click();
  await compose.waitFor({ state: "detached" });

  await openSettings(page);
  assert.deepEqual(await axeBlocking(page), [], "settings");
  assert.deepEqual(errors, []);
  await context.close();
});

test("theme: a light device stays light until Appearance says Dark; the choice survives a reload; Device puts it back", async () => {
  const { context, page, errors } = await open("light");
  assert.equal(await background(page), LIGHT_BG);
  try {
    await choose(page, "Dark");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    assert.equal(await background(page), DARK_BG);
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#0f1419");

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor();
    assert.equal(await background(page), DARK_BG, "kept after a reload");
  } finally {
    await choose(page, "Device");
  }
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-theme")), false);
  assert.equal(await background(page), LIGHT_BG);
  assert.deepEqual(errors, []);
  await context.close();
});

test("theme: Light on a dark device, in Russian", async () => {
  const { context, page } = await open("dark", "ru-RU");
  try {
    await choose(page, "Светлое");
    assert.equal(await background(page), LIGHT_BG);
  } finally {
    await choose(page, "Как на устройстве");
  }
  assert.equal(await background(page), DARK_BG);
  await context.close();
});
