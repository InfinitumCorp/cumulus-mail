import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/bridge/sync` — the IMAP bridge's incremental read (docs/imap-bridge.md).
 *
 * 404 unless `MAIL_BRIDGE=on`, so the endpoint does not exist on a normal deployment. With it on, the
 * caller sends `Authorization: Bearer <app password>` and a folder; the answer carries UIDVALIDITY,
 * the changed UIDs and the next modseq. Nothing here writes mail.
 */
export const Route = createFileRoute("/api/bridge/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { bridgeEnabled } = await import("@/lib/mail/bridge/config");
        if (!bridgeEnabled()) return new Response("Not found", { status: 404 });
        const { authorize, bridgeDb, json, FOLDER_NAME } = await import("@/lib/mail/bridge/http");
        const db = await bridgeDb();
        const who = await authorize(db, request, "read");
        if (who instanceof Response) return who;
        const body = (await request.json().catch(() => ({}))) as { folder?: unknown; sinceModseq?: unknown; limit?: unknown };
        const folder = typeof body.folder === "string" ? body.folder : "";
        if (!FOLDER_NAME.test(folder)) return json({ error: "bad_folder" }, 400);
        const { syncFolder } = await import("@/lib/mail/bridge/sync");
        const report = await syncFolder(db, who.tenantId, {
          folder,
          sinceModseq: Number(body.sinceModseq) || 0,
          limit: Number(body.limit) || undefined,
        });
        return json(report, 200, { "x-ratelimit-remaining": String(who.remaining) });
      },
    },
  },
});
