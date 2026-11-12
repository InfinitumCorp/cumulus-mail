import { createFileRoute } from "@tanstack/react-router";
import { authForRequest } from "@/lib/auth/server";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => authForRequest(request).handler(request),
      POST: ({ request }) => authForRequest(request).handler(request),
    },
  },
});
