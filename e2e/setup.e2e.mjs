// First-run setup and the empty states, in a browser: the "Finish setting up" card, the setup dialog
// (accessible, saves name and signature), dismissing it, the no-results search, and Russian.
// The card shows on a new mailbox (settings.setupPending); `?setup=1` shows it on demand, as here.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

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

async function open(path = "/?setup=1", locale = "en-US") {
  const context = await browser.newContext({ locale, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(path, URL_BASE).href, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page, errors };
}

/** Serious or critical WCAG 2.1 A/AA violations on the page as it is now. */
async function axeBlocking(page) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} at ${v.nodes[0]?.target.join(" ")}`);
  });
  return violations;
}

test("setup: the card opens an accessible dialog that saves the display name and signature", async () => {
  const { context, page, errors } = await open();
  const card = page.getByRole("region", { name: "Finish setting up your mailbox" });
  await card.waitFor({ timeout: 10_000 });
  await card.getByRole("button", { name: "Set up" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up your mailbox" });
  await dialog.waitFor();
  assert.deepEqual(await axeBlocking(page), []);
  // Focus is inside the dialog.
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);

  const nameField = dialog.getByLabel("Display name");
  const original = await nameField.inputValue();
  const signatureField = dialog.getByLabel("Signature");
  const originalSignature = await signatureField.inputValue();
  await nameField.fill("Ada Setup Test");
  await signatureField.fill("Ada\nSent from Cumulus");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("region", { name: "Finish setting up your mailbox" }).count(), 0, "the card is gone");

  // The new name is the mailbox's name now (the account button in the sidebar shows it).
  await page.getByRole("button", { name: /Ada Setup Test/ }).first().waitFor({ timeout: 10_000 });

  // Put things back for the other tests sharing this mailbox.
  await page.goto(new URL("/?setup=1", URL_BASE).href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Set up" }).click();
  await page.getByLabel("Display name").fill(original || "Alex Reid");
  await page.getByLabel("Signature").fill(originalSignature);
  await page.getByRole("button", { name: "Save" }).click();
  assert.deepEqual(errors, []);
  await context.close();
});

test("setup: 'Not now' hides the card, and Escape closes the dialog without saving", async () => {
  const { context, page } = await open();
  await page.getByRole("button", { name: "Set up" }).click();
  await page.getByRole("dialog", { name: "Set up your mailbox" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Set up your mailbox" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Not now" }).click();
  assert.equal(await page.getByRole("region", { name: "Finish setting up your mailbox" }).count(), 0);
  await context.close();
});

test("empty states: a search with no results says so, accessibly", async () => {
  const { context, page } = await open("/");
  await page.getByRole("searchbox", { name: "Search mail" }).or(page.getByLabel("Search mail")).first().fill("zzqqxx-nothing");
  await page.getByText("No messages match “zzqqxx-nothing”.").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("[data-row-id]").count(), 0);
  assert.deepEqual(await axeBlocking(page), []);
  await context.close();
});

test("setup and empty states in Russian", async () => {
  const { context, page } = await open("/?setup=1", "ru-RU");
  await page.getByRole("region", { name: "Завершите настройку почтового ящика" }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Настроить" }).click();
  await page.getByRole("dialog", { name: "Настройка почтового ящика" }).waitFor();
  assert.equal(await page.getByLabel("Отображаемое имя").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Поиск в почте").or(page.getByRole("searchbox")).first().fill("zzqqxx-nothing");
  await page.getByText("Нет писем по запросу «zzqqxx-nothing».").waitFor({ timeout: 10_000 });
  await context.close();
});
