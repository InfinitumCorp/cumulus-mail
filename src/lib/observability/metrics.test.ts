import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestInboundEmail } from "../mail/inbound.ts";
import { openMailbox } from "../mail/mailbox.ts";
import { queueDepth } from "../mail/outbound/queue.ts";
import { createHarness, profile } from "../mail/test-support.ts";
import { metric, metricLine } from "./metrics.ts";

/** Lines printed to stdout while `run` runs. */
async function captured(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => void lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.flatMap((l) => {
    try {
      const parsed = JSON.parse(l);
      return parsed && typeof parsed === "object" && "metric" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

test("a metric line has a timestamp, the metric name and the region, and never an address", () => {
  const saved = process.env.MAIL_REGION;
  process.env.MAIL_REGION = "RU";
  try {
    const line = metricLine("mail.outbound.result", { outcome: "bounced", status: "5.1.1", note: "to leah@example.org" }, new Date("2026-11-13T00:00:00Z"));
    assert.deepEqual(line, { t: "2026-11-13T00:00:00.000Z", metric: "mail.outbound.result", region: "ru", outcome: "bounced", status: "5.1.1", note: "[redacted]" });
  } finally {
    if (saved === undefined) delete process.env.MAIL_REGION;
    else process.env.MAIL_REGION = saved;
  }
  let printed = "";
  metric("auth.failure", { reason: "no_session" }, (l) => (printed = l));
  assert.equal(JSON.parse(printed).reason, "no_session");
  assert.doesNotThrow(() => metric("auth.failure", {}, () => { throw new Error("stdout gone"); }), "metrics never break the work");
});

test("an inbound message produces its auth results and its outcome; unknown recipients and duplicates are counted", async () => {
  const harness = await createHarness();
  try {
    await openMailbox(harness.db, "m-in", profile("m-in", "m.in@cumuluscloud.app"));
    const raw = new TextEncoder().encode(["From: Leah <leah@example.org>", "To: <m.in@cumuluscloud.app>", "Subject: Hi", "", "Hello"].join("\r\n"));
    const lines = await captured(async () => {
      await ingestInboundEmail(harness.db, harness.storageFor, { from: "leah@example.org", to: "m.in@cumuluscloud.app", raw });
      await ingestInboundEmail(harness.db, harness.storageFor, { from: "leah@example.org", to: "m.in@cumuluscloud.app", raw });
      await ingestInboundEmail(harness.db, harness.storageFor, { from: "leah@example.org", to: "nobody@cumuluscloud.app", raw });
    });
    const auth = lines.filter((l) => l.metric === "mail.inbound.auth");
    assert.equal(auth.length, 1);
    assert.deepEqual(Object.keys(auth[0]!).filter((k) => ["spf", "dkim", "dmarc", "disposition"].includes(k)).sort(), ["disposition", "dkim", "dmarc", "spf"]);
    assert.deepEqual(lines.filter((l) => l.metric === "mail.inbound.result").map((l) => l.outcome), ["stored", "duplicate", "no_mailbox"]);
    assert.doesNotMatch(JSON.stringify(lines), /@/, "no address in any metric line");
  } finally {
    await harness.close();
  }
});

test("queue depth counts queued and in-flight rows and the age of the oldest", async () => {
  const harness = await createHarness();
  try {
    await openMailbox(harness.db, "m-q", profile("m-q", "m.q@cumuluscloud.app"));
    const empty = await queueDepth(harness.db);
    assert.deepEqual(empty, { queued: 0, sending: 0, oldestQueuedSeconds: 0 });
    for (const [id, status, age] of [["q1", "queued", 600], ["q2", "queued", 30], ["q3", "sending", 5], ["q4", "sent", 9000]] as const) {
      await harness.db.query(
        `insert into cumulus_mail.outbound_queue (tenant_id, id, message_id, recipient, recipient_bidx, mail_from, raw, status, created_at)
         values ('m-q', $1, $1, 'x', $1, 'x', '', $2, now() - make_interval(secs => $3))`,
        [id, status, age],
      );
    }
    const depth = await queueDepth(harness.db);
    assert.equal(depth.queued, 2);
    assert.equal(depth.sending, 1);
    assert.ok(depth.oldestQueuedSeconds >= 599 && depth.oldestQueuedSeconds < 700, String(depth.oldestQueuedSeconds));
  } finally {
    await harness.close();
  }
});
