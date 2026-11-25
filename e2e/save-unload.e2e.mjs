// A change is never silently lost to a reload: while its save is in flight the page says so
// (<html data-saving="1">) and leaving asks first (beforeunload); once saved, leaving is free again.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");

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

const leavingIsBlocked = (page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test("while a save is in flight, leaving the page asks first; once it lands, it does not", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");
    assert.equal(await leavingIsBlocked(page), false, "an idle page can be left freely");

    // Hold the next save (a POST server-function call) for two seconds.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page.locator("[data-row-id]").first().click();
    await page.locator('button[aria-label="Trash"]').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.saving === "1", null, { timeout: 10_000 });
    assert.equal(await leavingIsBlocked(page), true, "leaving mid-save is refused (the browser asks)");

    release();
    await page.waitForFunction(() => document.documentElement.dataset.saving === "0", null, { timeout: 15_000 });
    assert.equal(await leavingIsBlocked(page), false, "after the save, leaving is free again");
  } finally {
    await context.close();
  }
});

// The same with a real reload, not a dispatched event: the person trashes a conversation and reloads at
// once, while its save is still on the wire. The browser asks (a beforeunload dialog); staying lets the
// save land, and the conversation is still in Trash after the next reload.
test("reloading right after a change, mid-save, asks first; staying keeps the change", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");

    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });

    const first = page.locator("[data-row-id]").first();
    const id = await first.getAttribute("data-row-id");
    await first.click();
    await page.locator('button[aria-label="Trash"]').first().click();
    await page.locator(`[data-row-id="${id}"]`).waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.saving), "1", "the save is in flight");

    // Reload now. The browser's "Leave site?" dialog comes up; the person chooses to stay.
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await page.reload({ timeout: 3_000 }).catch(() => undefined);
    assert.deepEqual(dialogs, ["beforeunload"], "reloading mid-save asks first");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.saving), "1", "still the same page, save pending");

    release();
    await page.waitForFunction(() => document.documentElement.dataset.saving === "0", null, { timeout: 15_000 });
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(dialogs, ["beforeunload"], "once saved, a reload does not ask");
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(`[data-row-id="${id}"]`).count(), 0, "still gone from the Inbox after a reload");
    await page.locator("aside.nav-pane").getByRole("button", { name: /^Trash/ }).first().click();
    await page.locator(`[data-row-id="${id}"]`).waitFor({ timeout: 15_000 });
  } finally {
    await context.close();
  }
});

// A save that hangs is abandoned (SAVE_TIMEOUT_MS; shortened here) so it cannot hold the "leave page?"
// prompt and every later save forever, and the change is retried by itself and lands.
test("a hung save times out, the page says so, and the change is saved again by itself", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => {
    globalThis.__mailSaveTimeoutMs = 1_500;
  });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");

    // Saves hang (never answer) until the page has said so; after that they go through.
    let hang = true;
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST" && hang) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await route.abort().catch(() => undefined);
        return;
      }
      await route.continue();
    });
    const first = page.locator("[data-row-id]").first();
    const id = await first.getAttribute("data-row-id");
    await first.click();
    await page.locator('button[aria-label="Trash"]').first().click();
    await page.getByText("Could not save your last change yet").waitFor({ timeout: 15_000 });
    hang = false;
    assert.equal(await page.evaluate(() => document.documentElement.dataset.saving), "0", "the hung save no longer holds the page");
    assert.equal(await leavingIsBlocked(page), false);

    // The retry (5 s later) lands, and the notice goes.
    await page.getByText("Could not save your last change yet").waitFor({ state: "detached", timeout: 20_000 });
    await page.unroute("**/_serverFn/**");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(`[data-row-id="${id}"]`).count(), 0, "the change was saved by the retry");
  } finally {
    await context.close();
  }
});

// Closing the tab anyway, after the "leave page?" prompt, while the full save is still held: the page sends
// just the change (a delta, with keepalive) on its way out, and it is there in the next tab. The full save
// never reaches the server in this test, so the change can only have come from the delta.
test("closing the tab mid-save still saves the change, as a small keepalive delta", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");

    // Full saves (server-function POSTs) hang and never reach the server. The delta is its own route.
    await context.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise(() => undefined);
        return;
      }
      await route.continue();
    });
    const first = page.locator("[data-row-id]").first();
    const id = await first.getAttribute("data-row-id");
    await first.click();
    await page.locator('button[aria-label="Trash"]').first().click();
    await page.locator(`[data-row-id="${id}"]`).waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.saving), "1", "the full save is held");

    // Close the tab; the browser asks first, and the person leaves anyway.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.close({ runBeforeUnload: true });
    // Playwright does not report a closed page's requests; the next tab is the proof.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await context.unroute("**/_serverFn/**");
    const next = await context.newPage();
    await next.goto(URL_BASE, { waitUntil: "networkidle" });
    await next.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    assert.equal(await next.locator(`[data-row-id="${id}"]`).count(), 0, "gone from the Inbox in the next tab");
    await next.locator("aside.nav-pane").getByRole("button", { name: /^Trash/ }).first().click();
    await next.locator(`[data-row-id="${id}"]`).waitFor({ timeout: 15_000 });
  } finally {
    await context.close();
  }
});
