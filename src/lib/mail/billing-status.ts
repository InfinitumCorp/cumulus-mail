/**
 * Billing state as the account dialog sees it. Dependency-free so the browser can import it; the
 * database read lives in `billing.ts`.
 */
import type { PlanStatus } from "./plans.ts";

export type BillingStatus = {
  enabled: boolean;
  subscribed: boolean;
  hasCustomer: boolean;
  planStatus: PlanStatus;
  /** ISO time the current period ends, when Stripe reported one. */
  renewsAt: string | null;
};

export const BILLING_OFF: BillingStatus = {
  enabled: false,
  subscribed: false,
  hasCustomer: false,
  planStatus: "active",
  renewsAt: null,
};

/** One line under the billing buttons, or null when there is nothing to say. */
export function billingNotice(status: BillingStatus): { text: string; urgent: boolean } | null {
  if (!status.enabled || !status.subscribed) return null;
  if (status.planStatus === "past_due") {
    return { text: "Payment failed. Update your card in Manage billing to keep your plan.", urgent: true };
  }
  if (!status.renewsAt) return null;
  const date = new Date(status.renewsAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return { text: `Renews ${date}.`, urgent: false };
}
