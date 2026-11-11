import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchAsText, searchFor } from "./search-core.ts";
import { mentionIn } from "./mentions.ts";

const ENV = { BRAVE_SEARCH_API_KEY: "brave_key", OMNIROUTE_BASE_URL: "https://omni.test/v1" };
const fetchImpl = (async (url: string) => {
  if (url.startsWith("https://api.search.brave.com")) {
    return new Response(JSON.stringify({ web: { results: [{ title: "Acme pricing", url: "https://acme.example/pricing", description: "Plans from $10" }] } }));
  }
  if (url.startsWith("https://omni.test/v1/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: "Acme starts at $10 a month [1]." } }] }));
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  return new Response("<title>Acme pricing</title><article>Plans from $10 a month.</article>", { headers: { "content-type": "text/html" } });
}) as unknown as typeof fetch;

describe("@search in Mail drafts", () => {
  it("routes @search, after @conjure and @scalvs", () => {
    assert.equal(mentionIn("@search Acme pricing"), "search");
    assert.equal(mentionIn("＠search погода"), "search");
    assert.equal(mentionIn("write to me@search.app"), null);
    assert.equal(mentionIn("@scalvs and @search"), "scalvs");
  });

  it("answers with cited sources for this person", async () => {
    const out = await searchFor(ENV, { text: "@search how much is Acme?", user: "u_1" }, { fetch: fetchImpl });
    assert.equal(out.mention, true);
    assert.equal(out.answer, "Acme starts at $10 a month [1].");
    assert.equal(searchAsText(out), "Acme starts at $10 a month [1].\n\nSources\n[1] Acme pricing\n    https://acme.example/pricing");
  });

  it("is off until a search engine is set", async () => {
    const out = await searchFor({}, { text: "@search anything", user: "u_1" });
    assert.match(out.error ?? "", /Search isn't connected/);
  });
});
