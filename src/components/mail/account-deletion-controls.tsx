import { useEffect, useRef, useState } from "react";
import { accountDeletion } from "@/lib/mail/api";

/**
 * Delete the mailbox. Asking starts a 7-day grace period, shown with its date and a Cancel button;
 * after it, everything is deleted for good. The confirmation names what goes.
 */
export function AccountDeletionControls() {
  const [purgeAfter, setPurgeAfter] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Each step replaces the button that was pressed, so focus is moved on purpose: otherwise it falls to
  // <body>, outside the modal dialog, and the next Tab starts from the top of the page.
  const keepRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<"keep" | "cancel" | "start" | null>(null);

  useEffect(() => {
    if (!focusNext) return;
    const target = { keep: keepRef, cancel: cancelRef, start: startRef }[focusNext].current;
    target?.focus();
    setFocusNext(null);
  }, [focusNext, confirming, purgeAfter]);

  useEffect(() => {
    let live = true;
    accountDeletion({ data: { action: "status" } })
      .then((result) => live && setPurgeAfter(result.status?.purgeAfter ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: "request" | "cancel") => {
    setBusy(true);
    setError("");
    try {
      const result = await accountDeletion({ data: { action } });
      setPurgeAfter(result.status?.purgeAfter ?? null);
      setConfirming(false);
      setFocusNext(action === "request" ? "cancel" : "start");
    } catch {
      setError("Could not change the deletion request.");
    } finally {
      setBusy(false);
    }
  };

  if (purgeAfter) {
    const when = new Date(purgeAfter).toLocaleDateString(undefined, { dateStyle: "long" });
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="text-xs text-accent">
          This mailbox will be deleted on {when}. Until then you can cancel.
        </p>
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={() => void run("cancel")}
          className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
        >
          Cancel deletion
        </button>
        {error ? <p role="alert" className="text-xs text-muted">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <>
          <p className="text-xs text-muted">
            Every message, attachment, contact, calendar entry, rule and setting will be deleted 7 days from now,
            and cannot be recovered after that. Download your data first if you want a copy.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("request")}
              className="inline-flex h-11 items-center border border-ink bg-ink px-3 text-sm text-paper disabled:opacity-60"
            >
              Delete in 7 days
            </button>
            <button
              ref={keepRef}
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setFocusNext("start");
              }}
              className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink"
            >
              Keep my mailbox
            </button>
          </div>
        </>
      ) : (
        <button
          ref={startRef}
          type="button"
          onClick={() => {
            setConfirming(true);
            // The safe choice gets focus first, so Enter pressed twice does not delete anything.
            setFocusNext("keep");
          }}
          className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink"
        >
          Delete mailbox…
        </button>
      )}
      {error ? <p role="alert" className="text-xs text-muted">{error}</p> : null}
    </div>
  );
}
