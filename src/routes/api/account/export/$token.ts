import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /api/account/export/<token>` — streams one part of "Download my data". The token is a
 * five-minute signed link issued by `requestDataExport` after the session check; this route only
 * verifies its signature, claims today's download (once a day per part) and streams the file.
 */
export const Route = createFileRoute("/api/account/export/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { dataExportResponse } = await import("@/lib/mail/mailbox.server");
        return dataExportResponse(params.token);
      },
    },
  },
});
