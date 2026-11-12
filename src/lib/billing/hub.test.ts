import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billingHubUrl, STORAGE_PLANS } from "./hub.ts";

describe("billing hub links", () => {
  it("subscribe links name the plan and come back to Mail", () => {
    const url = new URL(billingHubUrl("subscribe", { plan: STORAGE_PLANS[0].id }, "https://mail.cumuluscloud.app"));
    assert.equal(url.origin + url.pathname, "https://mail.cumuluscloud.app/api/billing/subscribe");
    assert.equal(url.searchParams.get("plan"), "cumulus_drive_200");
    assert.equal(url.searchParams.get("return"), "https://mail.cumuluscloud.app/");
  });
  it("manage links open the portal; only Drive storage plans are sold here", () => {
    assert.match(billingHubUrl("manage", {}, "https://mail.cumuluscloud.app"), /\/api\/billing\/manage\?return=/);
    for (const plan of STORAGE_PLANS) assert.match(plan.id, /^cumulus_drive_/);
  });
});
