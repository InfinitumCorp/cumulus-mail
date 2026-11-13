// The Russia path end to end, in a real browser against the dev server:
//   - host detection: a ru.* host gets Russian whatever the browser's language, unless the person chose
//     otherwise (?lang= or the language menu, which is remembered);
//   - Accept-Language / navigator.languages on the US host: Russian only for a Russian browser;
//   - the legal pages: served only on the Russia copy, and only as a visible, unindexed draft until every
//     field is filled AND MAIL_LEGAL_RU_REVIEWED=yes (the reviewed case is unit-tested in legal.test.ts:
//     this server runs without those settings, as any copy does before the owner sets them).
//
// `ru.localhost` stands in for ru.mail.cumuluscloud.app: browsers resolve *.localhost to this machine,
// and the dev server accepts it, so the host-based code paths run unchanged.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL_US = process.env.E2E_URL;
if (!URL_US) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const { port } = new URL(URL_US);
const URL_RU = `http://ru.localhost:${port}/`;

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

async function open(url, locale) {
  const context = await browser.newContext({ locale, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page, errors };
}

const lang = (page) => page.evaluate(() => document.documentElement.lang);

test("a ru.* host starts in Russian even for an English browser", async () => {
  const { context, page, errors } = await open(URL_RU, "en-US");
  await page.getByRole("heading", { name: "Входящие" }).waitFor({ timeout: 10_000 });
  assert.equal(await lang(page), "ru");
  assert.deepEqual(errors, []);
  await context.close();
});

test("on a ru.* host, ?lang=en and a remembered menu choice still win", async () => {
  const viaQuery = await open(`${URL_RU}?lang=en`, "ru-RU");
  await viaQuery.page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 10_000 });
  assert.equal(await lang(viaQuery.page), "en");
  await viaQuery.context.close();

  const { context, page, errors } = await open(URL_RU, "ru-RU");
  await page.getByRole("heading", { name: "Входящие" }).waitFor({ timeout: 10_000 });
  await page.locator("select.lang-switch").selectOption("en");
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 10_000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  assert.equal(await lang(page), "en", "the choice outlasts a reload on the Russian host");
  assert.deepEqual(errors, []);
  await context.close();
});

test("on the US host the browser's language decides: Russian for ru, English for anything unsupported", async () => {
  for (const [locale, heading, code] of [
    ["ru-RU", "Входящие", "ru"],
    ["ru", "Входящие", "ru"],
    ["uk-UA", "Inbox", "en"],
    ["de-DE", "Inbox", "en"],
  ]) {
    const { context, page, errors } = await open(URL_US, locale);
    await page.getByRole("heading", { name: heading }).waitFor({ timeout: 10_000 });
    assert.equal(await lang(page), code, locale);
    assert.deepEqual(errors, [], locale);
    await context.close();
  }
});

test("Russian legal pages: a visible, unindexed draft on the Russia copy, absent on the US copy", async () => {
  const context = await browser.newContext({ locale: "ru-RU" });
  const page = await context.newPage();
  for (const [doc, title] of [
    ["privacy", "Политика конфиденциальности"],
    ["terms", "Пользовательское соглашение"],
  ]) {
    const response = await page.goto(`${URL_RU}legal/${doc}`);
    assert.equal(response?.status(), 200, doc);
    assert.equal(response?.headers()["x-robots-tag"], "noindex, nofollow", `${doc}: a draft must not be indexed`);
    assert.equal(response?.headers()["cache-control"], "no-store");
    assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex, nofollow");
    const banner = page.getByRole("note");
    assert.match(await banner.innerText(), /ЧЕРНОВИК — документ не имеет юридической силы/, doc);
    assert.ok((await page.locator("mark.todo").count()) > 0, `${doc}: unfilled fields are marked`);
    assert.match(await page.locator("h1").first().innerText(), new RegExp(title), doc);
    assert.equal(await page.locator("script").count(), 0, `${doc}: plain HTML, no scripts`);
  }
  assert.equal((await page.goto(`${URL_RU}legal/cookies`))?.status(), 404, "only the two documents exist");
  assert.equal((await page.goto(`${URL_US}legal/privacy`))?.status(), 404, "the US copy does not serve them");
  await context.close();
});
