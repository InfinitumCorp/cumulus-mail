// Phones under 400px and the installable app: no sideways scrolling in the list, a message or compose at
// 360 and 320px; the reader's actions are one row; the manifest is the app's own; and offline, the service
// worker shows the offline page while nothing it stores contains mail.
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

async function phone(width) {
  const context = await browser.newContext({ viewport: { width, height: 740 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page, errors };
}

/** Elements that stick out past the right edge (outside sideways scrollers), and the page's scroll width. */
async function overflow(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      if (!box.width || box.right <= width + 1) continue;
      let scroller = el.parentElement;
      while (scroller && !/(auto|scroll|hidden)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
      if (!scroller || scroller === document.body || scroller === document.documentElement) out.push(`${el.tagName}.${String(el.className).slice(0, 50)}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, width, out: out.slice(0, 5) };
  });
}

for (const width of [360, 320]) {
  test(`phone ${width}px: list, message and compose fit the screen`, async () => {
    const { context, page, errors } = await phone(width);
    const list = await overflow(page);
    assert.equal(list.scrollWidth, list.width, `list scrolls sideways: ${list.out}`);
    assert.deepEqual(list.out, []);

    await page.locator("[data-row-id]").first().click();
    const back = page.getByRole("button", { name: "Back to list" });
    await back.waitFor();
    const message = await overflow(page);
    assert.equal(message.scrollWidth, message.width, `message scrolls sideways: ${message.out}`);
    // The actions are one row (it scrolls sideways), so the message starts near the top.
    const bar = await back.evaluate((el) => el.parentElement.getBoundingClientRect().height);
    assert.ok(bar <= 56, `action bar is ${bar}px tall`);
    await back.click();

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const compose = page.getByRole("dialog", { name: "Compose" });
    await compose.waitFor();
    const box = await compose.boundingBox();
    assert.ok(box.width <= width && box.x >= 0, "compose fits the width");
    const sheet = await overflow(page);
    assert.equal(sheet.scrollWidth, sheet.width);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("installable: the page links the app's own manifest (one link) with 192 and 512 icons", async () => {
  const { context, page } = await phone(390);
  const links = await page.locator('link[rel="manifest"]').evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  assert.deepEqual(links, ["/manifest.webmanifest"]);
  const manifest = await (await page.request.get(new URL("/manifest.webmanifest", URL_BASE).href)).json();
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, URL_BASE).href);
    assert.equal(response.status(), 200, icon.src);
    assert.match(response.headers()["content-type"], /image\/png/);
  }
  await context.close();
});

test("offline: the service worker shows the offline page, and nothing it stored contains mail", async () => {
  const { context, page } = await phone(390);
  // Dev builds do not register it (src/components/service-worker.tsx); register the same file here.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  // Read a message while online, so there is mail on the page that a careless worker could have cached.
  const subject = (await page.locator("[data-row-id]").first().innerText()).split("\n").find((line) => line.length > 12);
  await page.locator("[data-row-id]").first().click();
  await page.getByRole("button", { name: "Back to list" }).waitFor();

  const stored = await page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) out.push({ url: new URL(request.url).pathname, body: await (await cache.match(request)).text() });
    }
    return out;
  });
  for (const entry of stored) {
    assert.match(entry.url, /^\/(offline\.html|favicon\.svg|icons\/[\w.-]+\.png|assets\/[\w.-]+\.(js|css|woff2?))$/, `unexpected cache entry ${entry.url}`);
    assert.equal(entry.body.includes(subject), false, `${entry.url} contains mail`);
  }
  assert.ok(stored.some((entry) => entry.url === "/offline.html"));

  await context.setOffline(true);
  await page.goto(URL_BASE).catch(() => undefined);
  await page.getByRole("heading", { name: "You're offline" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText("Нет подключения к сети").count(), 1);
  await context.setOffline(false);
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await context.close();
});
