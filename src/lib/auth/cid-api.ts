import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./middleware";

/**
 * Server functions for the account dialog: Cumulus://ID sessions and the
 * OpenPGP key directory. Each one runs as the signed-in person, with the
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

export const publishMailKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { armored?: unknown };
    if (typeof value?.armored !== "string" || !value.armored.trim()) throw new Error("Missing key");
    return { armored: value.armored.slice(0, 70_000) };
  })
  .handler(async ({ context, data }) => {
    const [{ cidCall }, { publishCidMailKey }] = await Promise.all([
      import("./cid-account.server"),
      import("./cid-account.ts"),
    ]);
    return publishCidMailKey(await cidCall(context.bearerToken), data.armored);
  });

export const withdrawMailKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(async ({ context, data }) => {
    const [{ cidCall }, { withdrawCidMailKey }] = await Promise.all([
      import("./cid-account.server"),
      import("./cid-account.ts"),
    ]);
    return withdrawCidMailKey(await cidCall(context.bearerToken), data.id);
  });

/**
 * Published keys for recipients on the platform domain, keyed by address.
 * Other addresses are not looked up: the directory only files keys for its
 * own domain.
 */
export const lookupRecipientKeys = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { addresses?: unknown };
    if (!Array.isArray(value?.addresses)) throw new Error("Missing addresses");
    const addresses = value.addresses
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.includes("@") && a.length <= 120);
    return { addresses: [...new Set(addresses)].slice(0, 50) };
  })
  .handler(async ({ data }) => {
    const [{ cidConfig }, { lookupCidMailKeys }, { mailDomain }] = await Promise.all([
      import("./cumulus-id.ts"),
      import("./cid-account.ts"),
      import("../mail/domain.ts"),
    ]);
    const { issuer } = cidConfig();
    const domain = `@${mailDomain()}`;
    const wanted = data.addresses.filter((address) => address.endsWith(domain));
    const found = await Promise.all(wanted.map((address) => lookupCidMailKeys(issuer, address)));
    const out: Record<string, string[]> = {};
    wanted.forEach((address, i) => {
      const armored = found[i]?.map((key) => key.armored) ?? [];
      if (armored.length) out[address] = armored;
    });
    return out;
  });
