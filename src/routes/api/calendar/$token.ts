import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /api/calendar/<token>.ics` — a mailbox's calendar as iCalendar, for subscribing from another
 * calendar app. The token is the only credential (src/lib/mail/calendar-feed.ts): an unknown or
 * rotated token gets 404, the same answer as no feed at all. Read-only: GET only.
 */
export const Route = createFileRoute("/api/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { calendarFeedResponse } = await import("@/lib/mail/mailbox.server");
        return calendarFeedResponse(params.token.replace(/\.ics$/i, ""));
      },
    },
  },
});
