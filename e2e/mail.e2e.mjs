// Browser smoke tests. Run with `npm run test:e2e` (scripts/e2e.mjs starts the dev server).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.E2E_URL;
if (!URL) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");

let browser;
before(async () => {
  // E2E_CHROMIUM_PATH picks a browser; otherwise Playwright's own, else a preinstalled Chromium.
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

/** A fresh page on the inbox, with any page error collected. */
async function open(width = 1280, height = 860, extra = {}) {
  const page = await browser.newPage({ viewport: { width, height }, ...extra });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { page, errors };
}

/** Wait until the store has pushed the latest change to the server. */
async function settle(page) {
  await page.waitForTimeout(2500);
}

test("the inbox loads from the local server with sample mail and no error banner", async () => {
  const { page, errors } = await open();
  const text = await page.locator("body").innerText();
  assert.equal(/MAIL_BLOB_KEY|import\.meta\.env|Unauthorized|Failed to/i.test(text), false);
  assert.ok((await page.locator("[data-row-id]").count()) >= 5);
  assert.equal(await page.getByRole("heading", { name: "Inbox" }).count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a change is saved on the server and survives a reload", async () => {
  const { page } = await open();
  const before = await page.getByRole("button", { name: "Remove star" }).count();
  await page.getByRole("button", { name: "Star", exact: true }).first().click();
  await settle(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Remove star" }).count(), before + 1);
  await page.close();
});

test("keyboard: j opens, Esc returns focus to the row, ? opens a focus-trapped help sheet", async () => {
  const { page } = await open();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  const firstId = await page.locator("[data-row-id]").first().getAttribute("data-row-id");
  await page.locator(`[data-row-id="${firstId}"][aria-current="true"]`).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const focusedRow = await page.evaluate(() => document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id"));
  assert.equal(focusedRow, firstId);

  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Shortcuts" });
  await sheet.waitFor();
  assert.equal(await sheet.getAttribute("aria-modal"), "true");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  await page.close();
});

test("folders: create, move a conversation in, open, rename and delete (mail goes back to the Inbox)", async () => {
  const { page } = await open();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("New folder", { exact: true }).fill("E2E Receipts");
  await page.keyboard.press("Enter");
  const folder = page.getByRole("button", { name: /^E2E Receipts/ });
  await folder.waitFor();

  const row = page.locator("[data-row-id]").first();
  const subject = (await row.innerText()).split("\n").find((line) => line.trim().length > 12)?.trim() ?? "";
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  await page.getByLabel("Move to folder").selectOption({ label: "E2E Receipts" });
  await settle(page);

  await folder.click();
  await page.getByRole("heading", { name: "E2E Receipts" }).waitFor();
  assert.ok((await page.locator("[data-row-id]").count()) >= 1);
  if (subject) assert.ok((await page.locator(".list-pane").innerText()).includes(subject.slice(0, 20)));

  await page.getByRole("button", { name: "Rename E2E Receipts" }).click();
  await page.getByLabel("Rename E2E Receipts", { exact: true }).fill("E2E Bills");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^E2E Bills/ }).waitFor();

  await page.getByRole("button", { name: "Delete E2E Bills" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^E2E Bills/ }).count(), 0);
  await page.close();
});

test("phone width: one column, compose from the title row fills the screen, folders in a drawer", async () => {
  const { page, errors } = await open(390, 844, { isMobile: true, hasTouch: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  const compose = page.getByRole("button", { name: "Compose" }).first();
  const box = await compose.boundingBox();
  assert.ok(box && box.width >= 44 && box.height >= 44 && box.y < 80, JSON.stringify(box));
  await compose.click();
  const sheet = page.getByRole("dialog", { name: "Compose" });
  await sheet.waitFor();
  const sheetBox = await sheet.boundingBox();
  assert.ok(sheetBox && sheetBox.height >= 800, JSON.stringify(sheetBox));
  await page.getByRole("button", { name: /close|discard/i }).first().click().catch(() => undefined);

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.getByLabel("Open folders").click();
  const drawer = page.locator(".nav-pane[data-open='true']");
  await drawer.waitFor();
  assert.ok(((await drawer.boundingBox())?.width ?? 0) >= 380);
  const small = await drawer.locator("button").evaluateAll((items) =>
    items.filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.height < 44;
    }).length,
  );
  assert.equal(small, 0);
  assert.deepEqual(errors, []);
  await page.close();
});
