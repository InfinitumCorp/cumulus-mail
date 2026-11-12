import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { buildCommit, cachedHealth, healthReport, resetHealthCache, timed } from "./health.ts";
import { regionFor } from "./region.ts";

beforeEach(() => resetHealthCache());

const ok = {
  db: async () => true,
  dbSource: () => "postgres" as const,
  storage: async () => true,
  storageKind: () => "s3" as const,
  now: () => new Date("2026-11-12T23:00:00Z"),
};

test("the region comes from MAIL_REGION, else a ru. host means Russia", () => {
  assert.equal(regionFor("mail.cumuluscloud.app", {}), "us");
  assert.equal(regionFor("ru.mail.cumuluscloud.app", {}), "ru");
  assert.equal(regionFor("RU.mail.cumuluscloud.app:443", {}), "ru");
  assert.equal(regionFor(null, {}), "us");
  assert.equal(regionFor("mail.cumuluscloud.app", { MAIL_REGION: "ru" }), "ru");
  assert.equal(regionFor("ru.mail.cumuluscloud.app", { MAIL_REGION: " US " }), "us");
  assert.equal(regionFor("ru.mail.cumuluscloud.app", { MAIL_REGION: "eu" }), "ru");
});

test("the commit is a short hash or 'unknown', never arbitrary text", () => {
  assert.equal(buildCommit({ APP_COMMIT: "6806a79a8e17" }), "6806a79a8e17");
  assert.equal(buildCommit({ APP_COMMIT: "postgres://user:pass@host/db" }), "unknown");
  assert.equal(buildCommit({}), "unknown");
});

test("a healthy copy reports ok with region, commit, db source and storage kind", async () => {
  const report = await healthReport("ru.mail.cumuluscloud.app", ok);
  assert.equal(report.status, "ok");
  assert.equal(report.service, "cumulus-mail");
  assert.equal(report.region, "ru");
  assert.equal(report.db.ok, true);
  assert.equal(report.db.source, "postgres");
  assert.equal(report.storage.kind, "s3");
  assert.equal(report.time, "2026-11-12T23:00:00.000Z");
});

test("a failing or hanging dependency degrades the report without leaking the error", async () => {
  const secret = "postgres://admin:hunter2@db.internal:5432/mail";
  const report = await healthReport("mail.cumuluscloud.app", {
    ...ok,
    db: async () => {
      throw new Error(`connect ECONNREFUSED ${secret}`);
    },
    storage: () => new Promise<boolean>(() => {}),
  });
  assert.equal(report.status, "degraded");
  assert.deepEqual({ ok: report.db.ok, error: report.db.error }, { ok: false, error: "unreachable" });
  assert.equal(JSON.stringify(report).includes("hunter2"), false);
  assert.equal(JSON.stringify(report).includes("db.internal"), false);
  // The storage check gave up at its timeout rather than hanging the request.
  const slow = await timed(() => new Promise<boolean>(() => {}), 50);
  assert.deepEqual({ ok: slow.ok, error: slow.error }, { ok: false, error: "timeout" });
});

test("results are reused for 30 seconds, so the endpoint cannot load the database", async () => {
  let calls = 0;
  const counting = { ...ok, db: async () => (calls += 1) > 0 };
  await cachedHealth("mail.cumuluscloud.app", counting, 1_000);
  await cachedHealth("mail.cumuluscloud.app", counting, 20_000);
  assert.equal(calls, 1);
  await cachedHealth("mail.cumuluscloud.app", counting, 40_000);
  assert.equal(calls, 2);
});
