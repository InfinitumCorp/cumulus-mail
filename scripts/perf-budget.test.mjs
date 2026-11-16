import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { kb, overBudget, ROUTES } from "./perf-budget.mjs";
import { projectRoot } from "./nitro-preset.mjs";

const budget = {
  totalJsGzip: 1000,
  largestChunkGzip: 500,
  routes: { "/": { jsGzip: 600, fcp: 100, load: 200, forbid: ["openpgp"] } },
};
const within = { totalJsGzip: 900, largestChunkGzip: 400, routes: [{ path: "/", js: ["index-a.js"], jsGzip: 500, fcp: 150, load: 250 }] };

test("within budget: no problems (timings get 2x slack)", () => {
  assert.deepEqual(overBudget(within, budget), []);
});

test("bytes are exact: one byte over fails", () => {
  const over = { ...within, totalJsGzip: 1001, routes: [{ ...within.routes[0], jsGzip: 601 }] };
  assert.deepEqual(overBudget(over, budget), ["total JS 1.0 kB > 1.0 kB", "/: JS 0.6 kB > 0.6 kB"]);
});

test("timings fail only past twice their budget", () => {
  const slow = { ...within, routes: [{ ...within.routes[0], fcp: 201, load: 399 }] };
  assert.deepEqual(overBudget(slow, budget), ["/: fcp 201 ms > 100 ms x2"]);
});

test("a chunk that must stay lazy fails the route when it loads up front", () => {
  const eager = { ...within, routes: [{ ...within.routes[0], js: ["index-a.js", "openpgp.min-XYZ.js"] }] };
  assert.deepEqual(overBudget(eager, budget), ["/: loads openpgp.min-XYZ.js up front; it should stay lazy"]);
});

test("every measured route has a budget, and the committed budget parses", () => {
  const committed = JSON.parse(readFileSync(join(projectRoot(), "perf-budget.json"), "utf8"));
  for (const route of ROUTES) assert.ok(committed.routes[route.path], `perf-budget.json has no entry for ${route.path}`);
  assert.ok(committed.totalJsGzip > 0 && committed.largestChunkGzip > 0);
});

test("kb formats one decimal", () => {
  assert.equal(kb(1536), "1.5 kB");
});
