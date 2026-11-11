/**
 * The @search call itself, server side (no framework imports, so it is testable with node --test).
 *
 *   @search <question>   Infinitum Search: reads the web and answers with numbered sources
 *
 * Search engine and model keys stay on the server.
 */
import { searchRoutesFromEnv } from "../../../server/search/search.mjs";

export type SearchSource = { n: number; title: string; url: string; snippet: string };
export type SearchReply = { mention?: boolean; query?: string; answer?: string | null; sources?: SearchSource[]; error?: string };

/** Runs the draft's @search question for this signed-in person. */
export async function searchFor(
  env: Record<string, string | undefined>,
  input: { text: string; context?: string; user: string },
  options: { fetch?: typeof fetch } = {},
): Promise<SearchReply> {
  const routes = searchRoutesFromEnv(env, { prefix: "/search", fetch: options.fetch });
  const res = await routes(
    new Request("https://mail.local/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input.text, context: input.context }) }),
    { user: input.user },
  );
  if (!res) return { error: "Search is unavailable." };
  const body = (await res.json()) as SearchReply;
  return res.ok ? body : { error: body.error || "Search is unavailable right now." };
}

/** The answer and its sources as plain text for a draft. */
export function searchAsText(reply: SearchReply): string {
  const sources = (reply.sources ?? []).map((s) => `[${s.n}] ${s.title}\n    ${s.url}`).join("\n");
  return `${reply.answer || "No written answer: here are the sources."}${sources ? `\n\nSources\n${sources}` : ""}`;
}
