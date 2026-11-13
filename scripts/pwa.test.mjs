// The installable app and its offline shell (public/manifest.webmanifest, public/sw.js): the manifest is
// installable, and the service worker never stores page HTML, API or server-function responses (mail).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { injectGrokPwaHead } from "./grok-pwa-shared.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://mail.cumuluscloud.app";

/** Runs public/sw.js in a sandbox with fake `self`, `caches` and `fetch`; returns its handlers and the cache. */
function loadWorker({ online = true } = {}) {
  const handlers = {};
  const stored = new Map();
  const cache = {
    addAll: async (urls) => urls.forEach((u) => stored.set(new URL(u, ORIGIN).href, `shell:${u}`)),
    put: async (request, response) => stored.set(request.url, response.body),
  };
  const sandbox = {
    URL,
    self: { location: { origin: ORIGIN }, addEventListener: (type, fn) => (handlers[type] = fn), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async (request) => {
        const url = typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
        return stored.has(url) ? { body: stored.get(url), fromCache: true } : undefined;
      },
    },
    fetch: async (request) => {
      if (!online) throw new TypeError("Failed to fetch");
      return {
        ok: true,
        type: "basic",
        body: `network:${request.url}`,
        headers: new Map([["cache-control", "public, max-age=31536000, immutable"]]),
        clone() {
          return this;
        },
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "public/sw.js"), "utf8"), sandbox);
  return { handlers, stored, sandbox };
}

/** Dispatches a fetch event; resolves to the response, or null when the worker left the request alone. */
async function dispatch(worker, path, { mode = "cors", method = "GET" } = {}) {
  let responded = null;
  const pending = [];
  worker.handlers.fetch({
    request: { url: new URL(path, ORIGIN).href, mode, method },
    respondWith: (p) => (responded = p),
    waitUntil: (p) => pending.push(p),
  });
  const response = responded ? await responded : null;
  await Promise.all(pending);
  return response;
}

test("manifest: installable (name, standalone, start_url, 192 and 512 icons, a maskable icon), and the files exist", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "Cumulus://Mail");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const png = readFileSync(join(ROOT, "public", icon.src));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h], icon.src);
  }
});

test("service worker: caches only the shell and hashed assets, never pages, API calls or server functions", () => {
  const { sandbox } = loadWorker();
  const ok = (path) => vm.runInContext(`cacheable(new URL(${JSON.stringify(path)}, ${JSON.stringify(ORIGIN)}))`, sandbox);
  for (const path of ["/offline.html", "/icons/icon-192.png", "/favicon.svg", "/assets/main-BxY1_2.js", "/assets/styles-9f.css", "/assets/inter-latin.woff2"]) {
    assert.equal(ok(path), true, path);
  }
  for (const path of ["/", "/?folder=sent", "/api/auth/get-session", "/api/calendar/abc", "/_serverFn/abc?payload=1", "/assets/../api/x.js", "/assets/x.json", "/inbox/m1", "/attachments/a1"]) {
    assert.equal(ok(path), false, path);
  }
});

test("service worker: pages come from the network and are not stored; offline, the offline page is shown", async () => {
  const online = loadWorker();
  await online.handlers.install({ waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 0));
  const page = await dispatch(online, "/?thread=t1", { mode: "navigate" });
  assert.equal(page.body, `network:${ORIGIN}/?thread=t1`);
  assert.deepEqual([...online.stored.keys()].sort(), [`${ORIGIN}/favicon.svg`, `${ORIGIN}/icons/icon-192.png`, `${ORIGIN}/offline.html`]);

  const offline = loadWorker({ online: false });
  await offline.handlers.install({ waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 0));
  const shell = await dispatch(offline, "/", { mode: "navigate" });
  assert.equal(shell.body, "shell:/offline.html");
});

test("service worker: API, server-function and non-GET requests are never intercepted; assets are cached", async () => {
  const worker = loadWorker();
  assert.equal(await dispatch(worker, "/api/auth/get-session"), null);
  assert.equal(await dispatch(worker, "/_serverFn/loadMailbox"), null);
  assert.equal(await dispatch(worker, "/_serverFn/saveMailbox", { method: "POST" }), null);
  assert.equal(await dispatch(worker, "https://grok.com/x.js".replace(ORIGIN, "")), null, "other origins pass through");
  await dispatch(worker, "/assets/main-abc.js");
  assert.deepEqual([...worker.stored.keys()], [`${ORIGIN}/assets/main-abc.js`]);
});

test("the platform head injector keeps the app's own manifest and touch icon (no second manifest link)", () => {
  const html = '<html><head><link rel="manifest" href="/manifest.webmanifest"/><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"/></head><body></body></html>';
  const out = injectGrokPwaHead(html);
  assert.equal(out.match(/rel="manifest"/g).length, 1);
  assert.doesNotMatch(out, /__grok\/manifest/);
  assert.doesNotMatch(out, /__grok\/icon-180/);
});
