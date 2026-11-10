import { test } from "node:test";
import assert from "node:assert/strict";
import { completeOpen, hostsFromEnv, NoModelHost, type Host } from "./open-models.ts";

const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

const A: Host = { name: "a", baseUrl: "https://a.test/v1", model: "auto", apiKey: "ka" };
const B: Host = { name: "b", baseUrl: "https://b.test/v1/", model: "gpt-oss-20b" };

test("hosts: OmniRoute first, then open-model backups", () => {
  assert.deepEqual(hostsFromEnv({}), []);
  const hosts = hostsFromEnv({ OMNIROUTE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "t", GROQ_API_KEY: "g" });
  assert.deepEqual(hosts.map((h) => [h.name, h.model]), [["omniroute", "auto"], ["workers-ai", "@cf/openai/gpt-oss-20b"], ["groq", "openai/gpt-oss-20b"]]);
  assert.equal(hosts[0]!.baseUrl, "http://localhost:20128/v1");
});

test("no hosts configured", async () => {
  await assert.rejects(completeOpen([], "s", "u"), NoModelHost);
});

test("switches to the next host when one fails, and strips <think>", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push(url);
    assert.equal(JSON.parse(String(init.body)).messages[0].content, "sys");
    return url.startsWith("https://a.test") ? new Response("down", { status: 503 }) : ok("<think>x</think>Brief.");
  }) as unknown as typeof fetch;
  const r = await completeOpen([A, B], "sys", "user", { fetchImpl, hedgeMs: 0 });
  assert.deepEqual(r, { text: "Brief.", host: "b" });
  assert.deepEqual(seen, ["https://a.test/v1/chat/completions", "https://b.test/v1/chat/completions"]);
});

test("races a slow host against the next one", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.startsWith("https://a.test")) await new Promise((r) => setTimeout(r, 300));
    return ok(url.startsWith("https://a.test") ? "slow" : "fast");
  }) as unknown as typeof fetch;
  const started = Date.now();
  const r = await completeOpen([A, B], "s", "u", { fetchImpl, hedgeMs: 20 });
  assert.equal(r.text, "fast");
  assert.ok(Date.now() - started < 250);
});

test("reports every failure when all hosts fail", async () => {
  const fetchImpl = (async () => ok("")) as unknown as typeof fetch;
  await assert.rejects(completeOpen([A, B], "s", "u", { fetchImpl, hedgeMs: 0 }), /a: empty reply; b: empty reply/);
});
