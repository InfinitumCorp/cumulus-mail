import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetGeoCache } from "./load.ts";
import {
  annotateDeliveryDetail,
  annotateMessage,
  emailDomain,
  geoEnabled,
  resetGeoHookState,
} from "./hook.ts";
import { syntheticGeoDatasets, syntheticGeoFiles } from "./sample.ts";

test("the geo flag is off unless it is explicitly enabled", () => {
  assert.equal(geoEnabled({}), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "0" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "false" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "off" }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "1" }), true);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: " TRUE " }), true);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "yes" }), true);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "on" }), true);
});

test("annotation is a no-op while the flag is off", async () => {
  const message = { headers: { subject: "Hello" }, folder: "inbox" as const };
  const logs: string[] = [];
  const result = await annotateMessage(
    message,
    { ip: "192.0.2.10", domain: "ads.example" },
    { env: {}, datasets: syntheticGeoDatasets(), log: (line) => logs.push(line) },
  );
  assert.equal(result, message);
  assert.deepEqual(result.headers, { subject: "Hello" });
  const detail = "Held in the outbox. This preview does not send outside Cumulus.";
  assert.equal(
    await annotateDeliveryDetail(detail, "news@ads.example", {
      env: {},
      datasets: syntheticGeoDatasets(),
      log: (line: string) => {
        logs.push(line);
      },
    }),
    detail,
  );
  assert.deepEqual(logs, []);
});

test("annotation records country and site category without touching the original headers", async () => {
  resetGeoHookState();
  const headers: Record<string, string> = { subject: "Hello" };
  const message = {
    headers,
    folder: "inbox" as const,
    auth: { disposition: "deliver", policy: "none" },
  };
  const logs: string[] = [];
  const result = await annotateMessage(
    message,
    { ip: "192.0.2.10", domain: emailDomain("news@ads.example") },
    {
      env: { INFINITUM_GEO_ENABLED: "1" },
      datasets: syntheticGeoDatasets(),
      log: (line: string) => {
        logs.push(line);
      },
    },
  );
  assert.equal(headers.subject, "Hello");
  assert.equal(result.headers?.subject, "Hello");
  assert.equal(result.headers?.["x-infinitum-geo-country"], "US");
  assert.equal(result.headers?.["x-infinitum-geo-site"], "category-ads");
  assert.equal(result.folder, "inbox");
  assert.equal(result.auth.disposition, "deliver");
  assert.equal(result.auth.policy, "none");
  assert.match(logs[0] ?? "", /country=US/);
  assert.match(logs[0] ?? "", /site=category-ads/);
  const detail = await annotateDeliveryDetail("Held.", "news@ads.example", {
    env: { INFINITUM_GEO_ENABLED: "1" },
    datasets: syntheticGeoDatasets(),
    log: (line) => logs.push(line),
  });
  assert.equal(detail, "Held. Geo site: category-ads.");
});

test("a miss leaves the message unchanged", async () => {
  const message = { headers: { subject: "Hello" } };
  const result = await annotateMessage(
    message,
    { ip: "198.51.100.10", domain: "unknown.example" },
    { env: { INFINITUM_GEO_ENABLED: "1" }, datasets: syntheticGeoDatasets(), log: () => {} },
  );
  assert.equal(result, message);
});

test("missing dataset files skip annotation", async () => {
  resetGeoHookState();
  resetGeoCache();
  const logs: string[] = [];
  const message = { headers: { subject: "Hello" } };
  const result = await annotateMessage(
    message,
    { ip: "192.0.2.10", domain: "ads.example" },
    {
      env: { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: join(tmpdir(), "cumulus-geo-missing") },
      log: (line: string) => {
        logs.push(line);
      },
    },
  );
  assert.equal(result, message);
  assert.match(logs[0] ?? "", /annotation skipped/);
});

test("a truncated dataset file skips annotation instead of failing the caller", async () => {
  resetGeoHookState();
  resetGeoCache();
  const dir = mkdtempSync(join(tmpdir(), "cumulus-geo-bad-"));
  const files = syntheticGeoFiles();
  writeFileSync(join(dir, "geoip.dat"), files.geoip.subarray(0, 4));
  writeFileSync(join(dir, "geosite.dat"), files.geosite);
  const logs: string[] = [];
  try {
    const message = { headers: { subject: "Hello" } };
    const result = await annotateMessage(
      message,
      { ip: "192.0.2.10", domain: "ads.example" },
      {
        env: { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: dir },
        log: (line: string) => {
          logs.push(line);
        },
      },
    );
    assert.equal(result, message);
    assert.match(logs[0] ?? "", /annotation skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetGeoCache();
  }
});

test("a directory of synthetic .dat files loads for annotation", async () => {
  resetGeoHookState();
  resetGeoCache();
  const dir = mkdtempSync(join(tmpdir(), "cumulus-geo-ok-"));
  const files = syntheticGeoFiles();
  writeFileSync(join(dir, "geoip.dat"), files.geoip);
  writeFileSync(join(dir, "geosite.dat"), files.geosite);
  try {
    const headers: Record<string, string> = {};
    const result = await annotateMessage(
      { headers },
      { ip: "203.0.113.8", domain: "mail.google.com" },
      { env: { INFINITUM_GEO_ENABLED: "on", INFINITUM_GEO_DIR: dir }, log: () => {} },
    );
    assert.equal(result.headers?.["x-infinitum-geo-country"], "CN");
    assert.equal(result.headers?.["x-infinitum-geo-site"], "google");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetGeoCache();
  }
});
