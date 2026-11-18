import assert from "node:assert/strict";
import { test } from "node:test";
import { drift, percentile } from "./api-soak.mjs";

test("percentile picks from sorted values", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 6);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test("drift: flat memory and latency pass; a steady climb fails", () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({ rssMb: 200 + (i % 2), p95: 20 }));
  assert.equal(drift(flat).ok, true);
  const leak = Array.from({ length: 10 }, (_, i) => ({ rssMb: 200 + i * 20, p95: 20 }));
  assert.equal(drift(leak).ok, false);
  const slower = Array.from({ length: 10 }, (_, i) => ({ rssMb: 200, p95: 20 + i * 10 }));
  assert.equal(drift(slower).ok, false);
  assert.equal(drift([{ rssMb: 1, p95: 1 }]).ok, true, "too short to judge");
});

test("drift: a partial last minute with a few slow requests does not count", () => {
  const rows = Array.from({ length: 30 }, () => ({ requests: 60000, rssMb: 515, p95: 14 }));
  rows.push({ requests: 3, rssMb: 519, p95: 34 });
  const d = drift(rows);
  assert.equal(d.ok, true);
  assert.ok(Math.abs(d.p95Growth) < 0.01, `p95 growth ${d.p95Growth}`);
});
