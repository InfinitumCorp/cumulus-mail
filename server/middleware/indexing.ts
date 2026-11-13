import { applyIndexing } from "../../src/lib/indexing.ts";

/**
 * `X-Robots-Tag: noindex, nofollow` on every response from a non-production host (platform URLs used
 * before cutover, previews, localhost). See src/lib/indexing.ts. Auto-registered (`serverDir: "./server"`).
 */
type IndexingEvent = {
  url: URL;
  req: { headers: Headers };
  res?: { headers?: Headers };
};

export default async function indexing(
  event: IndexingEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const host = event.req.headers.get("host") ?? event.url.host;
  if (event.res?.headers) applyIndexing(event.res.headers, host);
  const result = await next();
  if (result instanceof Response && !result.headers.has("x-robots-tag")) {
    const headers = applyIndexing(new Headers(result.headers), host);
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
  }
  return result;
}
