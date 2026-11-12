// © Infinitum Corporation®. All rights reserved.
//
// Paid storage is bought on the Cumulus billing hub, which signs the person in with Cumulus ID and
// opens Stripe Checkout. Mail holds no Stripe key and makes no payment request: these are links.

const BILLING_HUB = String(import.meta.env?.VITE_BILLING_HUB_URL || "https://mail.cumuluscloud.app/api/billing").replace(/\/+$/, "");

/** Storage is shared by Mail and Drive, so Mail sells the Cumulus Drive plans. */
export const STORAGE_PLANS = [
  { id: "cumulus_drive_200", name: "200 GB", price: "$2.99/month" },
  { id: "cumulus_drive_2tb", name: "2 TB", price: "$9.99/month" },
] as const;

export function billingHubUrl(action: "subscribe" | "manage", params: Record<string, string> = {}, origin = globalThis.location?.origin ?? "") {
  const query = new URLSearchParams({ ...params, ...(origin ? { return: `${origin}/` } : {}) });
  return `${BILLING_HUB}/${action}?${query}`;
}
