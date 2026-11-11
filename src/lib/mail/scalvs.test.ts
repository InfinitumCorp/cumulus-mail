import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askScalvsFor } from "./scalvs-core.ts";
import { mentionIn } from "./mentions.ts";

const ENV = { OPENCLAW_GATEWAY_URL: "https://claw.test", OPENCLAW_GATEWAY_TOKEN: "tok_secret", OPENCLAW_AGENT: "openclaw/mail" };

describe("@scalvs / @scalus in Mail drafts", () => {
  it("routes @conjure, @scalvs and @scalus, and ignores @openclaw", () => {
    assert.equal(mentionIn("@conjure will Acme sign by March?"), "conjure");
    assert.equal(mentionIn("@scalvs reply that Friday works"), "scalvs");
    assert.equal(mentionIn("Thanks! @SCALUS file this under Q4"), "scalvs");
    assert.equal(mentionIn("＠scalvs summarise the thread"), "scalvs");
    assert.equal(mentionIn("@openclaw do it"), null);
    assert.equal(mentionIn("write to ops@scalvs.app"), null);
    assert.equal(mentionIn("plain draft"), null);
    assert.equal(mentionIn("@scalvs and @conjure"), "conjure");
  });

  it("sends the task and the thread to the SCALVS agent as this person", async () => {
    const sent: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Friday at 10 works. Booked." } }] }));
    }) as unknown as typeof fetch;
    const out = await askScalvsFor(ENV, { text: "@scalvs book Friday with Ada", context: "Ada: does Friday work?", user: "u_1" }, { fetch: fetchImpl });
    assert.deepEqual(out, { mention: true, text: "Friday at 10 works. Booked.", agent: "openclaw/mail" });
    assert.equal(sent[0].user, "mail:u_1");
    assert.equal(sent[0].model, "openclaw/mail");
    assert.equal(sent[0].messages[0].content, "Ada: does Friday work?");
    assert.equal(sent[0].messages[1].content, "book Friday with Ada");
    assert.ok(!JSON.stringify(out).includes("tok_secret"));
  });

  it("is off until configured and says how to connect", async () => {
    const out = await askScalvsFor({}, { text: "@scalvs book Friday", user: "u_1" });
    assert.match(out.error ?? "", /OPENCLAW_GATEWAY_URL/);
  });

  it("asks for a task after a bare @scalvs", async () => {
    const out = await askScalvsFor(ENV, { text: "@scalvs", user: "u_1" }, { fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    assert.match(out.error ?? "", /Tell SCALVS what to do/);
  });
});
