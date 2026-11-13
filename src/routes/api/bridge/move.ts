import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/bridge/move` — IMAP UID MOVE (phase 2). Body: `{ from, to, uids }`. Answers the destination's
 * UIDVALIDITY and `[old, new]` UID pairs, which is what the bridge needs for COPYUID. Write scope, and
 * only while MAIL_BRIDGE_WRITE=on; never into Drafts or Quarantine, never out of Quarantine.
 */
export const Route = createFileRoute("/api/bridge/move")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorize, bridgeDb, json, FOLDER_NAME } = await import("@/lib/mail/bridge/http");
        const { bridgeEnabled } = await import("@/lib/mail/bridge/config");
        if (!bridgeEnabled()) return new Response("Not found", { status: 404 });
        const db = await bridgeDb();
        const who = await authorize(db, request, "write");
        if (who instanceof Response) return who;
        const body = (await request.json().catch(() => ({}))) as { from?: unknown; to?: unknown; uids?: unknown };
        const from = typeof body.from === "string" ? body.from : "";
        const to = typeof body.to === "string" ? body.to : "";
        if (!FOLDER_NAME.test(from) || !FOLDER_NAME.test(to)) return json({ error: "bad_folder" }, 400);
        if (!Array.isArray(body.uids) || body.uids.length > 500) return json({ error: "bad_uids" }, 400);
        const { BridgeWriteError, moveMessages } = await import("@/lib/mail/bridge/write");
        try {
          return json(await moveMessages(db, who.tenantId, { from, to, uids: body.uids.map(Number) }));
        } catch (error) {
          if (error instanceof BridgeWriteError) return json({ error: error.code }, error.code === "bad_folder" ? 400 : 403);
          throw error;
        }
      },
    },
  },
});
