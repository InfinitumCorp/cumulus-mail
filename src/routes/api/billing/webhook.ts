import { createFileRoute } from "@tanstack/react-router";

/**
 * Stripe webhook. No session: the request is trusted only if its `Stripe-Signature` verifies against
 * `STRIPE_WEBHOOK_SECRET` over the raw body. Register `<app origin>/api/billing/webhook` in Stripe.
 */
export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { receiveStripeWebhook } = await import("@/lib/mail/mailbox.server");
        const payload = await request.text();
        return receiveStripeWebhook(payload, request.headers.get("stripe-signature"));
      },
    },
  },
});
