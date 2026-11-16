// The language menu lives in the mail header (#lang-switch), not floating over the sidebar: at 1280x800
// it sits at the header's right end, on a 360px phone in the title row, in English and Russian. It never
// covers the sidebar (the FIRM card, the storage meter) or an open dialog. Pages without the header
// (a share link) keep the floating menu.
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
    if (path || !existsSync(fallback)) throw error;
    browser = await chromium.launch({ executablePath: fallback });
  }
});
after(async () => {
  await browser?.close();
});

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true };

async function openMail(options, locale) {
  const context = await browser.newContext({ ...options, locale });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  const menu = page.locator("header #lang-switch select.lang-switch");
  await menu.waitFor({ timeout: 15_000 });
  return { context, page, menu, errors };
}

/** Whether the language menu itself is what is drawn at the centre of `box`. */
const menuOnTop = (page, box) =>
  page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches("select.lang-switch") ?? false, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });

const LOCALES = [
  { locale: "en-US", label: "Language", inbox: "Inbox", compose: "Compose", close: "Close composer", folders: "Open folders", other: "ru", otherInbox: "Входящие" },
  { locale: "ru-RU", label: "Язык", inbox: "Входящие", compose: "Написать", close: "Закрыть редактор", folders: "Открыть папки", other: "en", otherInbox: "Inbox" },
];

for (const l of LOCALES) {
  test(`${l.locale} 1280x800: the menu is at the header's right end and covers nothing`, async () => {
    const { context, page, menu, errors } = await openMail(DESKTOP, l.locale);
    await page.getByRole("heading", { name: l.inbox }).waitFor({ timeout: 10_000 });
    assert.equal(await menu.getAttribute("aria-label"), l.label, "named in the interface language");
    assert.equal(await page.locator(".lang-float").count(), 0, "no floating menu on the mail page");
    const header = await page.locator("header").first().boundingBox();
    const box = await menu.boundingBox();
    assert.ok(box.y >= header.y && box.y + box.height <= header.y + header.height, "inside the header");
    assert.ok(header.x + header.width - (box.x + box.width) <= 40, "at its right end");
    const compose = await page.locator("header").getByRole("button", { name: l.compose, exact: true }).last().boundingBox();
    assert.ok(compose && box.x >= compose.x + compose.width, "right of Compose");
    assert.equal(await menuOnTop(page, box), true, "nothing covers it");
    // The sidebar's bottom, where the floating menu used to sit, shows the sidebar.
    const aside = await page.locator("aside.nav-pane").boundingBox();
    assert.ok(box.y + box.height <= aside.y, "above the sidebar, not over it");
    const corner = await page.evaluate(() => document.elementFromPoint(24, window.innerHeight - 24)?.closest("select.lang-switch") ?? null);
    assert.equal(corner, null, "the bottom-left corner is the sidebar's");
    // It still works from the header.
    await menu.selectOption(l.other);
    await page.getByRole("heading", { name: l.otherInbox }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator("select.lang-switch").count(), 1, "still one menu");
    assert.equal(await page.locator("header #lang-switch select.lang-switch").count(), 1, "still in the header");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${l.locale} 360px phone: the menu is in the title row, 44px tall, no sideways scroll`, async () => {
    const { context, page, menu, errors } = await openMail(PHONE, l.locale);
    await page.getByRole("heading", { name: l.inbox }).waitFor({ timeout: 10_000 });
    assert.equal(await menu.getAttribute("aria-label"), l.label);
    assert.equal(await page.locator(".lang-float").count(), 0);
    const box = await menu.boundingBox();
    const folders = await page.getByRole("button", { name: l.folders }).boundingBox();
    assert.ok(folders, "the folders button is there");
    assert.ok(Math.abs(box.y + box.height / 2 - (folders.y + folders.height / 2)) <= 4, "same row as the folders button");
    assert.ok(box.height >= 44, `touch height ${box.height}`);
    assert.ok(box.x >= 0 && box.x + box.width <= 360, "inside the screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll");
    assert.equal(await menuOnTop(page, box), true);
    // Compose is a full-screen sheet here: it covers the menu while open, and the menu is back after.
    await page.locator("header").getByRole("button", { name: l.compose, exact: true }).first().click();
    const sheet = page.getByRole("dialog").first();
    await sheet.waitFor();
    assert.equal(await menuOnTop(page, box), false, "covered while compose is open");
    await sheet.getByRole("button", { name: l.close }).click();
    await sheet.waitFor({ state: "detached" });
    assert.equal(await menuOnTop(page, box), true, "back after it closes");
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("a page without the mail header (a share link) keeps the floating menu", async () => {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await page.goto(`${URL_BASE.replace(/\/$/, "")}/p/00000000000000000000000000000000`, { waitUntil: "networkidle" });
  await page.locator(".lang-float select.lang-switch").waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("select.lang-switch").count(), 1);
  await context.close();
});
