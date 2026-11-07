import { createLabyrinthClient } from "./client.ts";
import type { LabyrinthClientOptions } from "./client.ts";
/** Better Auth/dev-preview identities are never interpreted as Cumulus ID identities. */
export function createMailLabyrinth(options: Omit<LabyrinthClientOptions, "token"> & { token: NonNullable<LabyrinthClientOptions["token"]> }) {
  if (typeof options.token !== "function") throw new Error("A Cumulus ID repository token provider is required");
  return createLabyrinthClient("cumulus-mail", { ...options, token: async () => {
    const token = await options.token();
    if (!token) throw new Error("Cumulus ID sign-in required");
    return token;
  } });
}
