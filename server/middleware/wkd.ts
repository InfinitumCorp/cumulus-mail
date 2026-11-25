import { wkdResponse } from "../../src/lib/mail/wkd.ts";

type WkdEvent = { url: URL; req: { method?: string } };

/**
 * Web Key Directory (RFC 7929) on the mail host. Other paths are untouched.
 * The response is the binary public key, or 404 when this server has not published one.
 */
export default async function wkdMiddleware(event: WkdEvent, next: () => unknown | Promise<unknown>): Promise<unknown> {
  if ((event.req.method ?? "GET").toUpperCase() !== "GET") return next();
  if (!event.url.pathname.startsWith("/.well-known/openpgpkey/")) return next();
  const { getSql } = await import("../../src/lib/db.ts");
  const sql = await getSql();
  return wkdResponse({ query: (text, params) => sql.query(text, params ?? []) }, event.url.pathname, event.url.host);
}
