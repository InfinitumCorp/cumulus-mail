import { useEffect, useState } from "react";
import { calendarFeed } from "@/lib/mail/api";

/**
 * "Subscribe from another calendar": a secret iCalendar URL. It is shown once, when it is made; making a
 * new one stops the old one working, and turning it off removes it.
 */
export function CalendarFeedControls() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    calendarFeed({ data: { action: "status" } })
      .then((result) => live && setEnabled(result.enabled))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: "rotate" | "disable") => {
    setBusy(true);
    setNote("");
    try {
      const result = await calendarFeed({ data: { action } });
      setEnabled(result.enabled);
      setUrl(result.url ? new URL(result.url, window.location.origin).toString() : null);
      if (action === "disable") setNote("Turned off. The old address no longer works.");
    } catch {
      setNote("Could not change the calendar feed.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNote("Copied.");
    } catch {
      setNote("Select the address and copy it.");
    }
  };

  return (
    <section aria-labelledby="calendar-feed-title" className="mt-6 border-t border-line pt-6">
      <h3 id="calendar-feed-title" className="text-lg tracking-tight">
        Subscribe from another calendar
      </h3>
      <p className="mt-1 max-w-lg text-sm text-muted">
        A private address Apple Calendar, Google Calendar or Outlook can subscribe to. Anyone with it can read
        these events, so keep it to yourself; make a new one if it leaks.
      </p>
      {url ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-muted" htmlFor="calendar-feed-url">
            Calendar address (shown once)
          </label>
          <input
            id="calendar-feed-url"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="h-11 w-full border border-line bg-transparent px-3 font-mono text-xs"
          />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {url ? (
          <button type="button" onClick={() => void copy()} className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink">
            Copy address
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("rotate")}
          className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
        >
          {enabled ? "Make a new address" : "Create address"}
        </button>
        {enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("disable")}
            className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
          >
            Turn off
          </button>
        ) : null}
      </div>
      {enabled && !url ? <p className="mt-2 text-xs text-muted">On. The address was shown when it was made; make a new one to see it again.</p> : null}
      {note ? (
        <p role="status" className="mt-2 text-xs text-muted">
          {note}
        </p>
      ) : null}
    </section>
  );
}
