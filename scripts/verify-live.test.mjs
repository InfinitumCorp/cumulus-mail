import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommit, checkRobots, LIVE_HOSTS, verifyLive } from "./verify-live.mjs";

const ROBOTS = "User-agent: *\nDisallow: /api/\nDisallow: /_serverFn/\n";

/** A fetcher answering by path; `robotsTag(path)` sets X-Robots-Tag. */
function site({ robots = ROBOTS, robotsTag = (path) => (path.startsWith("/p/") ? "noindex, nofollow" : ""), health = { commit: "68722aa12345" } } = {}) {
  return async (url) => {
    const { pathname } = new URL(url);
    const headers = new Headers();
    const tag = robotsTag(pathname);
    if (tag) headers.set("x-robots-tag", tag);
    if (pathname === "/robots.txt") return new Response(robots, { status: robots === null ? 404 : 200, headers });
    if (pathname === "/api/health") return Response.json(health, { headers });
    return new Response("<html></html>", { status: 200, headers });
  };
}

test("robots: production name, robots.txt and share pages right", async () => {
  const r = await checkRobots(LIVE_HOSTS.us, site());
  assert.equal(r.ok, true, r.detail);
});

test("robots: fails when robots.txt does not keep crawlers out of the API", async () => {
  const r = await checkRobots(LIVE_HOSTS.us, site({ robots: "User-agent: *\nDisallow: /api/\n" }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /_serverFn/);
});

test("robots: a platform host must be noindex, a production name must not", async () => {
  const platform = "https://cumulus-mail-api.example.workers.dev";
  assert.equal((await checkRobots(platform, site())).ok, false, "platform / indexable");
  assert.equal((await checkRobots(platform, site({ robotsTag: () => "noindex, nofollow" }))).ok, true);
  const r = await checkRobots(LIVE_HOSTS.ru, site({ robotsTag: () => "noindex, nofollow" }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /production name/);
});

test("robots: a share page that is indexable fails", async () => {
  const r = await checkRobots(LIVE_HOSTS.us, site({ robotsTag: () => "" }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /share page/);
});

test("commit: a prefix either way matches; another commit or none fails", async () => {
  assert.equal((await checkCommit(LIVE_HOSTS.us, site(), "68722aa")).ok, true);
  assert.equal((await checkCommit(LIVE_HOSTS.us, site({ health: { commit: "68722aa" } }), "68722aa12345")).ok, true);
  assert.equal((await checkCommit(LIVE_HOSTS.us, site(), "bc6f9d6")).ok, false);
  assert.equal((await checkCommit(LIVE_HOSTS.us, site({ health: {} }), "68722aa")).ok, false);
});

test("verifyLive refuses an unknown region, and fails on the old page worker", async () => {
  await assert.rejects(() => verifyLive({ region: "eu", log: () => {} }), /--region/);
  const old = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/robots.txt") return new Response("User-agent: *\n", { status: 200 });
    return new Response(pathname === "/" ? '<script src="/cumulus-config.js"></script>' : "Not found", { status: pathname === "/" ? 200 : 404 });
  };
  const lines = [];
  const result = await verifyLive({ region: "us", fetcher: old, log: (line) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.ok(lines.some((line) => line.includes("FAIL health")));
  assert.ok(lines.at(-1).includes("FAIL"));
});
