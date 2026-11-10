import type { CloudLinkRef } from "./model.ts";

export type CloudLinkProvider = {
  create(file: { name: string; size: number }, ttlMs: number): Promise<CloudLinkRef>;
};

/** Share links on the Cumulus://Cloud Drive page. */
export const DRIVE_SHARE_BASE = "https://drive.cumuluscloud.app/s/";

const DRIVE_SHARE = /^https:\/\/drive\.cumuluscloud\.app\/s\/[a-f0-9]{32}$/;

export function isDriveShareHref(href: string): boolean {
  return DRIVE_SHARE.test(href);
}

/**
 * Placeholder for Cumulus://Cloud. It returns an expiring Drive link and does not
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
        href: `${DRIVE_SHARE_BASE}${id}`,
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
    },
  };
}
