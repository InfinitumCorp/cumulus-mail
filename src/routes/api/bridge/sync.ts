import { createFileRoute } from "@tanstack/react-router";
import type { MailQuery } from "@/lib/mail/query";

/**
 * `POST /api/bridge/sync` — the read-only IMAP bridge's incremental read (docs/imap-bridge.md).
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

        const { getSql } = await import("@/lib/db");
        const { checkToken } = await import("@/lib/mail/bridge/tokens");
        const { rateCheck, syncFolder } = await import("@/lib/mail/bridge/sync");
        const sql = await getSql();
        const db: MailQuery = { query: (text, params) => sql.query(text, params ?? []) };

        const who = await checkToken(db, request.headers.get("authorization"));
        if (!who.ok) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
        }
        const rate = rateCheck(who.id);
        if (!rate.allowed) {
          return Response.json(
            { error: "rate_limited" },
            { status: 429, headers: { "retry-after": String(rate.retryAfterSeconds), "cache-control": "no-store" } },
          );
        }
        const body = (await request.json().catch(() => ({}))) as { folder?: unknown; sinceModseq?: unknown; limit?: unknown };
        const folder = typeof body.folder === "string" ? body.folder : "";
        if (!/^[a-z0-9][a-z0-9 _-]{0,64}$/i.test(folder)) {
          return Response.json({ error: "bad_folder" }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        const report = await syncFolder(db, who.tenantId, {
          folder,
          sinceModseq: Number(body.sinceModseq) || 0,
          limit: Number(body.limit) || undefined,
        });
        return Response.json(report, {
          status: 200,
          headers: { "cache-control": "no-store", "x-ratelimit-remaining": String(rate.remaining) },
        });
      },
    },
  },
});
