import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/bridge/idle` — IMAP IDLE as a long poll (docs/imap-bridge.md, phase 2). Body:
 * `{ folder, sinceModseq }`. Answers as soon as the folder changes, or after MAIL_BRIDGE_IDLE_SECONDS
 * with `changed: false`. Read scope. 404 unless MAIL_BRIDGE=on.
 */
export const Route = createFileRoute("/api/bridge/idle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorize, bridgeDb, json, FOLDER_NAME } = await import("@/lib/mail/bridge/http");
        const { bridgeEnabled } = await import("@/lib/mail/bridge/config");
        if (!bridgeEnabled()) return new Response("Not found", { status: 404 });
        const db = await bridgeDb();
        const who = await authorize(db, request, "read");
        if (who instanceof Response) return who;
        const body = (await request.json().catch(() => ({}))) as { folder?: unknown; sinceModseq?: unknown };
        const folder = typeof body.folder === "string" ? body.folder : "";
        if (!FOLDER_NAME.test(folder)) return json({ error: "bad_folder" }, 400);
        const { waitForChange } = await import("@/lib/mail/bridge/idle");
        return json(await waitForChange(db, who.tenantId, folder, Number(body.sinceModseq) || 0, { signal: request.signal }));
      },
    },
  },
});
