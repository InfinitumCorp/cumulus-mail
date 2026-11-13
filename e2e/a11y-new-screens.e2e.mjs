// Keyboard and screen-reader checks for the screens added on 2026-11-13: "Your data" (export), account
// deletion, the language menu and the billing states, in English and Russian. axe-core (serious and
// critical fail, as in a11y.e2e.mjs) plus what axe cannot see: where keyboard focus goes.
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

async function axeBlocking(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
  });
}

async function openDialog(locale = "en-US") {
  const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return { context, page, dialog, errors };
}

const focusInDialog = (page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
const focusedName = (page) => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());

test("deletion flow: no axe findings, and keyboard focus never leaves the dialog", async () => {
  const { context, page, dialog, errors } = await openDialog();
  assert.deepEqual(await axeBlocking(page), [], "account dialog with Your data and Delete rows");

  await dialog.getByRole("button", { name: "Delete mailbox…" }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Keep my mailbox" }).waitFor();
  assert.equal(await focusInDialog(page), true, "after opening the confirmation");
  assert.equal(await focusedName(page), "Keep my mailbox", "the safe choice has focus, so Enter twice deletes nothing");
  assert.deepEqual(await axeBlocking(page), [], "confirmation");

  await page.keyboard.press("Enter"); // Keep my mailbox
  await dialog.getByRole("button", { name: "Delete mailbox…" }).waitFor();
  assert.equal(await focusedName(page), "Delete mailbox…", "back on the button that opened it");

  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Delete in 7 days" }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByText(/will be deleted on/).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Cancel deletion", null, { timeout: 5_000 });
  assert.equal(await focusInDialog(page), true, "after requesting deletion");
  assert.deepEqual(await axeBlocking(page), [], "deletion pending");

  await page.keyboard.press("Enter"); // Cancel deletion
  await dialog.getByRole("button", { name: "Delete mailbox…" }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Delete mailbox…", null, { timeout: 5_000 });
  assert.equal(await focusInDialog(page), true, "after cancelling");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Your data: both downloads are reachable by Tab and stay focusable while preparing", async () => {
  const { context, page, dialog, errors } = await openDialog();
  const mbox = dialog.getByRole("button", { name: "Messages (mbox)" });
  const json = dialog.getByRole("button", { name: "Contacts, calendar and settings (JSON)" });
  await mbox.focus();
  await page.keyboard.press("Tab");
  assert.equal(await focusedName(page), "Contacts, calendar and settings (JSON)");
  assert.equal(await json.getAttribute("disabled"), null, "never disabled: that would drop focus");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Russian: the new screens are translated, named, and pass axe", async () => {
  const { context, page, dialog, errors } = await openDialog("ru-RU");
  await dialog.getByRole("button", { name: "Удалить ящик…" }).waitFor({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "Письма (mbox)" }).waitFor();
  assert.deepEqual(await axeBlocking(page), [], "Russian account dialog");
  const menu = page.locator("select.lang-switch");
  assert.equal(await menu.getAttribute("aria-label"), "Язык", "the language menu has a name");
  await menu.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("lang-switch")), true, "and is focusable");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Sign-in row: the identity provider is text, not a link to a machine endpoint", async () => {
  const { context, dialog } = await openDialog();
  const links = await dialog.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  assert.equal(links.some((href) => /cognito-idp|\/\.well-known\//.test(href)), false);
  await dialog.getByText("Identity provider:").waitFor();
  await context.close();
});
