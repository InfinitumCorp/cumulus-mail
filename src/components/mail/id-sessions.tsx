import { useCallback, useEffect, useState } from "react";
import { listIdSessions, signOutIdSession, signOutOtherIdSessions } from "@/lib/auth/cid-api";
import { CUMULUS_ID_ACCOUNT_URL, type CidResult, type CidSession } from "@/lib/auth/cid-account";

const when = (iso: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "unknown");

function SignedOutNote({ accountUrl = CUMULUS_ID_ACCOUNT_URL }: { accountUrl?: string }) {
  return (
    <p className="text-sm text-muted">
      Mail's Cumulus://ID sign-in has expired, so sessions can't be listed here.{" "}
      <a className="text-accent" href={accountUrl} target="_blank" rel="noopener noreferrer">
        Manage sessions at id.cumuluscloud.app
      </a>
      .
    </p>
  );
}

/** Live Cumulus://ID sessions for the account dialog, with sign-out per session. */
export function IdSessions() {
  const [result, setResult] = useState<CidResult<CidSession[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    void listIdSessions()
      .then(setResult)
      .catch(() => setResult({ status: "error", message: "Could not load sessions." }));
  }, []);

  useEffect(load, [load]);

  const after = (outcome: CidResult<unknown>, done: string) => {
    if (outcome.status === "signed-out") setResult(outcome);
    else if (outcome.status === "error") setNote(outcome.message);
    else {
      setNote(done);
      load();
    }
  };

  const run = (action: () => Promise<CidResult<unknown>>, done: string) => {
    setBusy(true);
    setNote("");
    void action()
      .then((outcome) => after(outcome, done))
      .catch(() => setNote("Cumulus://ID did not answer. Try again."))
      .finally(() => setBusy(false));
  };

  if (!result) return <p className="text-sm text-muted">Loading sessions…</p>;
  if (result.status === "signed-out") return <SignedOutNote accountUrl={result.accountUrl} />;
  if (result.status === "error") return <p className="text-sm text-muted">{result.message}</p>;

  const sessions = result.value;
  const others = sessions.filter((session) => !session.current);
  return (
    <div className="flex flex-col gap-3">
      {sessions.length === 0 ? <p className="text-sm text-muted">No live sessions.</p> : null}
      <ul className="flex flex-col">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-start justify-between gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
            <div className="min-w-0 text-sm">
              <p className="truncate">{session.device}</p>
              <p className="mt-1 text-muted">
                {session.client ?? "Cumulus://ID account"}
                {session.country ? ` · ${session.country}` : ""}
              </p>
              <p className="mt-1 font-mono text-xs text-muted">Last active {when(session.lastSeenAt)}</p>
            </div>
            {session.current ? (
              <span className="shrink-0 text-sm text-accent">This session</span>
            ) : (
              <button
                type="button"
                disabled={busy}
                className="inline-flex h-11 shrink-0 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-50"
                onClick={() => run(() => signOutIdSession({ data: { id: session.id } }), "Session signed out.")}
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length ? (
        <button
          type="button"
          disabled={busy}
          className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink disabled:opacity-50"
          onClick={() => run(() => signOutOtherIdSessions(), "Signed out everywhere else.")}
        >
          Sign out everywhere else
        </button>
      ) : null}
      {note ? (
        <p className="text-sm text-muted" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
