import type { CloudLinkRef } from "./model.ts";

export type CloudLinkProvider = {
  create(file: { name: string; size: number }, ttlMs: number): Promise<CloudLinkRef>;
};

/**
 * Placeholder for Cumulus://Cloud. It returns an expiring link and does not
 * upload bytes. A live Drive transfer is not available from this app.
 */
export function stubCloudLinks(now = Date.now()): CloudLinkProvider {
  return {
    async create(file, ttlMs) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return {
        name: file.name.slice(0, 180),
        size: Math.max(0, Math.trunc(file.size)),
        href: `https://cloud.cumuluscloud.app/s/${id}`,
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
    },
  };
}
