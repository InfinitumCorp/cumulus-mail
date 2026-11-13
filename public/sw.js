/*
 * Cumulus://Mail service worker: an offline shell, nothing more.
 *
 * What it keeps (Cache Storage, this origin only):
 *   - the offline page, the icons and the favicon (on install);
 *   - built JS/CSS/fonts under /assets/ (content-hashed, so they never change under the same URL).
 * What it never keeps: page HTML (it is rendered with your mail in it), /api/*, server functions,
 * attachments, anything that is not a GET, or any response marked no-store or private. Mail bodies are
 * only ever in page HTML or API/server-function responses, so they never reach the cache.
 *
 * Pages always come from the network. Only when that fails (offline) is the offline page shown.
 * Bump VERSION to drop every old cache on the next visit.
 */
const VERSION = "v1";
const CACHE = `cumulus-shell-${VERSION}`;
const SHELL = ["/offline.html", "/icons/icon-192.png", "/favicon.svg"];

/** Paths the worker may put in the cache. Everything else passes straight through to the network. */
function cacheable(url) {
  return SHELL.includes(url.pathname) || /^\/assets\/[\w.-]+\.(?:js|css|woff2?)$/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Network only; never stored. Offline (a network error, not an HTTP error) → the offline page.
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }
  if (!cacheable(url)) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          const cacheControl = response.headers.get("cache-control") ?? "";
          if (response.ok && response.type === "basic" && !/no-store|private/i.test(cacheControl)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        }),
    ),
  );
});
