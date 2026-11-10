import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailLabyrinth } from "./index.ts";
test("Mail requires a separate real CID credential and never uses the preview/app user id", async () => {
  const client = createMailLabyrinth({ endpoint: "https://cid.example/api/labyrinth", token: () => undefined, fetch: async () => { throw new Error("Must not call without CID"); } });
  await assert.rejects(client.repositories(), /Cumulus ID sign-in/);
});
test("Mail exposes explicit artifact save/load under its fixed namespace", async () => {
  const client = createMailLabyrinth({ endpoint: "https://cid.example/api/labyrinth", token: () => "lbrnth_session", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.product, "cumulus-mail");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer lbrnth_session");
    assert.equal(init?.redirect, "error"); return Response.json({ content: "selected draft" });
  } });
  assert.equal(await client.load("repo", "commit", "draft.json"), "selected draft");
});
test("Mail runtime relay never treats Better Auth or preview identity as a CID credential", async () => {
  const { default: middleware } = await import("../../../server/middleware/labyrinth.ts");
  const previous = process.env.LBRNTH_ENDPOINT;
  process.env.LBRNTH_ENDPOINT = "https://cid.example/api/labyrinth";
  try {
    const response = await middleware({ url: new URL("https://mail.example/api/labyrinth"), req: new Request("https://mail.example/api/labyrinth", { method: "POST", headers: { cookie: "preview=user", "content-type": "application/json", "x-labyrinth": "1" }, body: "{}" }) }, () => { throw new Error("Must not pass the repository route to the preview app"); });
    assert.equal((response as Response).status, 401);
  } finally { if (previous === undefined) delete process.env.LBRNTH_ENDPOINT; else process.env.LBRNTH_ENDPOINT = previous; }
});
