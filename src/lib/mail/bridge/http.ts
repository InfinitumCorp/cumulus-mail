/**
 * What every bridge route does first: 404 while the bridge is off, the token check (with the scope the
 * route needs), and the per-token rate limit. Returns a Response to send as-is, or the caller.
 */
import type { MailQuery } from "../query.ts";
import { bridgeEnabled } from "./config.ts";
import { rateCheck } from "./sync.ts";
import { checkToken } from "./tokens.ts";

const NO_STORE = { "cache-control": "no-store" };

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** IMAP mailbox names the bridge passes through: the app's folder ids. */
export const FOLDER_NAME = /^[a-z0-9][a-z0-9 _-]{0,64}$/i;

export async function authorize(
  db: MailQuery,
  request: Request,
  need: "read" | "write",
  env: Record<string, string | undefined> = process.env,
): Promise<Response | { tenantId: string; tokenId: string; remaining: number }> {
  if (!bridgeEnabled(env)) return new Response("Not found", { status: 404 });
  const who = await checkToken(db, request.headers.get("authorization"), { env, need });
  if (!who.ok) {
    // A read token on a write route is 403: the caller is known, the action is not allowed.
    return who.reason === "scope" ? json({ error: "forbidden" }, 403) : json({ error: "unauthorized" }, 401);
  }
  const rate = rateCheck(who.id, { env });
  if (!rate.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(rate.retryAfterSeconds) });
  return { tenantId: who.tenantId, tokenId: who.id, remaining: rate.remaining };
}

export async function bridgeDb(): Promise<MailQuery> {
  const { getSql } = await import("../../db.ts");
  const sql = await getSql();
  return { query: (text, params) => sql.query(text, params ?? []) };
}
