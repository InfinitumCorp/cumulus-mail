import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createAbuseIntake } from "./abuse.ts";
import { openMailbox } from "./mailbox.ts";
import { createSuppressionList } from "./suppression.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("an abuse report is stored and the address is suppressed for the reporting tenant", async () => {
  const { db } = harness;
  await openMailbox(db, "abuse-ada", profile("abuse-ada", "abuse.ada@cumuluscloud.app", "Ada"));
  await openMailbox(db, "abuse-bea", profile("abuse-bea", "abuse.bea@cumuluscloud.app", "Bea"));
  const intake = createAbuseIntake(db, "abuse-ada");
  const result = await intake.submit({
    reporter: "ada@cumuluscloud.app",
    subjectAddress: "spam@example.test",
    detail: "Unsolicited bulk mail.",
  });
  assert.equal(result.suppressed, true);
  assert.match(result.id, /^abuse-/);
  assert.equal(await createSuppressionList(db, "abuse-ada").has("spam@example.test"), true);
  assert.equal(await createSuppressionList(db, "abuse-bea").has("spam@example.test"), false);
  const reports = await db.query<{ detail: string }>(
    `select detail from cumulus_mail.abuse_reports where tenant_id = $1 and id = $2`,
    ["abuse-ada", result.id],
  );
  assert.equal(reports[0]?.detail, "Unsolicited bulk mail.");
});
