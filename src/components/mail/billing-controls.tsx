import { useEffect, useState } from "react";
import { getBillingStatus, openBillingPortal, startCheckout } from "@/lib/mail/api";
import { BILLING_OFF, billingNotice, type BillingStatus } from "@/lib/mail/billing-status";

const CHOICES = [
  { key: "plus_monthly", label: "Plus, monthly" },
  { key: "plus_yearly", label: "Plus, yearly" },
  { key: "pro_monthly", label: "Pro, monthly" },
  { key: "pro_yearly", label: "Pro, yearly" },
  { key: "business_monthly", label: "Business, monthly" },
  { key: "business_yearly", label: "Business, yearly" },
] as const;

/**
 * Upgrade (Stripe Checkout) and Manage billing (Stripe Customer Portal). Renders nothing until the
 * server says Stripe is configured, so the account dialog is unchanged when billing is off.
 */
export function BillingControls() {
  const [status, setStatus] = useState<BillingStatus>(BILLING_OFF);
  const [choice, setChoice] = useState<string>(CHOICES[0].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    getBillingStatus()
      .then((next) => live && setStatus(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!status.enabled) return null;
  const notice = billingNotice(status);

  const go = async (open: () => Promise<{ url: string }>) => {
    setBusy(true);
    setError("");
    try {
      const { url } = await open();
      window.location.assign(url);
    } catch (problem) {
      setBusy(false);
      setError(problem instanceof Error ? problem.message : "Billing is unavailable right now.");
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status.subscribed ? null : (
          <>
            <select
              aria-label="Plan to upgrade to"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="h-11 w-full border border-line bg-transparent px-3 text-sm"
            >
              {CHOICES.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              className="inline-flex h-11 items-center border border-ink bg-ink px-3 text-sm text-paper disabled:opacity-60"
              onClick={() => void go(() => startCheckout({ data: { lookupKey: choice } }))}
            >
              Upgrade
            </button>
          </>
        )}
        {status.hasCustomer ? (
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
            onClick={() => void go(() => openBillingPortal())}
          >
            Manage billing
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role={notice.urgent ? "alert" : undefined} className={notice.urgent ? "text-xs text-accent" : "text-xs text-muted"}>
          {notice.text}
        </p>
      ) : null}
      {error && (
        <p role="alert" className="text-xs text-muted">
          {error}
        </p>
      )}
    </div>
  );
}
