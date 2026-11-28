import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./middleware";

/**
 * Server functions for the account dialog's Cumulus://ID sessions. (Recipient keys
 * are looked up on the server by lookupPgpKeys: this host's WKD, then
 * Cumulus://ID's GET /api/keys/{email}.) Each one runs as the signed-in person, with the
 * Cumulus://ID access token Better Auth stored for them; the browser never
 * sees that token.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function idInput(input: unknown): { id: string } {
  const value = input as { id?: unknown };
  if (typeof value?.id !== "string" || !SAFE_ID.test(value.id)) throw new Error("Missing id");
  return { id: value.id };
}

export const listIdSessions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const [{ cidCall }, { listCidSessions }] = await Promise.all([
      import("./cid-account.server"),
      import("./cid-account.ts"),
    ]);
    return listCidSessions(await cidCall(context.bearerToken));
  });

export const signOutIdSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(async ({ context, data }) => {
    const [{ cidCall }, { revokeCidSession }] = await Promise.all([
      import("./cid-account.server"),
      import("./cid-account.ts"),
    ]);
    return revokeCidSession(await cidCall(context.bearerToken), data.id);
  });

export const signOutOtherIdSessions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const [{ cidCall }, { revokeOtherCidSessions }] = await Promise.all([
      import("./cid-account.server"),
      import("./cid-account.ts"),
    ]);
    return revokeOtherCidSessions(await cidCall(context.bearerToken));
  });
