import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/bridge/append?folder=sent` — IMAP APPEND of a sent copy (phase 2). The body is the raw
 * RFC 822 message (`message/rfc822`); `?seen=0` / `?flagged=1` carry the APPEND flags. Answers
 * UIDVALIDITY and the new UID (APPENDUID). Write scope, MAIL_BRIDGE_WRITE=on, Sent only, From must be one
 * of the mailbox's own addresses. The same bytes twice give the same UID.
 */
export const Route = createFileRoute("/api/bridge/append")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorize, bridgeDb, json } = await import("@/lib/mail/bridge/http");
        const { appendMaxBytes, bridgeEnabled } = await import("@/lib/mail/bridge/config");
        if (!bridgeEnabled()) return new Response("Not found", { status: 404 });
        const db = await bridgeDb();
        const who = await authorize(db, request, "write");
        if (who instanceof Response) return who;
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > appendMaxBytes()) return json({ error: "too_large" }, 413);
        const raw = new Uint8Array(await request.arrayBuffer());
        const url = new URL(request.url);
        const { BridgeWriteError, appendSentCopy } = await import("@/lib/mail/bridge/write");
        const { openTenantStorage } = await import("@/lib/storage");
        const { storageEnforced } = await import("@/lib/mail/inbound");
        try {
          const result = await appendSentCopy(
            db,
            (tenantId) => openTenantStorage(tenantId),
            who.tenantId,
            { folder: url.searchParams.get("folder") ?? "", raw, seen: url.searchParams.get("seen") !== "0", flagged: url.searchParams.get("flagged") === "1" },
            { enforceStorage: storageEnforced(process.env.MAIL_ENFORCE_STORAGE) },
          );
          return json(result, result.duplicate ? 200 : 201);
        } catch (error) {
          if (error instanceof BridgeWriteError) {
            const status = error.code === "too_large" ? 413 : error.code === "mailbox_full" ? 507 : error.code === "bad_message" ? 400 : 403;
            return json({ error: error.code }, status);
          }
          throw error;
        }
      },
    },
  },
});
