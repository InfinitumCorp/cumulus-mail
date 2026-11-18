import { createFileRoute } from "@tanstack/react-router";

/**
 * Stripe webhook. No session: the request is trusted only if its `Stripe-Signature` verifies against
 * `STRIPE_WEBHOOK_SECRET` over the raw body (at most 1 MB, read only when the header is present).
 * Register `<app origin>/api/billing/webhook` in Stripe.
 */
export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { readStripeWebhook } = await import("@/lib/mail/billing");
        const read = await readStripeWebhook(request);
        if (read instanceof Response) return read;
        const { receiveStripeWebhook } = await import("@/lib/mail/mailbox.server");
        return receiveStripeWebhook(read.payload, read.signature);
      },
    },
  },
});
