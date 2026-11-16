import { useState } from "react";
import { requestDataExport } from "@/lib/mail/api";

const PARTS = [
  { part: "mbox", label: "Messages (mbox)" },
  { part: "json", label: "Contacts, calendar and settings (JSON)" },
] as const;

/**
 * "Download my data" (right of access). Each part can be downloaded once a day; the link the server
 * returns is good for five minutes and starts a normal browser download.
 */
export function DataExportControls() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const download = async (part: "mbox" | "json") => {
    setBusy(part);
    setNote("");
    try {
      const result = await requestDataExport({ data: { part } });
      if ("url" in result) {
        window.location.assign(result.url);
      } else {
        const when = new Date(result.retryAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        setNote(`Already downloaded today. Available again ${when}.`);
      }
    } catch {
      setNote("Could not prepare the download.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">A copy of everything in this mailbox, decrypted for you. Each file once a day.</p>
      <div className="flex flex-wrap gap-2">
        {PARTS.map(({ part, label }) => (
          <button
            key={part}
            type="button"
            // aria-disabled, not disabled: disabling the focused button would drop keyboard focus.
            aria-disabled={busy !== null}
            aria-busy={busy === part}
            onClick={() => {
              if (busy === null) void download(part);
            }}
            className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
          >
            {busy === part ? "Preparing…" : label}
          </button>
        ))}
      </div>
      {note ? (
        <p role="status" className="text-xs text-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}
