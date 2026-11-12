import { useCallback, useEffect, useState } from "react";
import { authClient, authEnabled } from "@/lib/auth/client";
import { deviceRows, type DeviceRow, type SessionLike } from "@/lib/auth/devices";

/**
 * Where this account is signed in to Mail, with sign-out per device and for every other device.
 * Uses Better Auth's own session list (`/api/auth/list-sessions`), whichever provider signed the
 * person in. Sessions on the identity provider itself are not listed. Hidden when sign-in is off.
 */
export function SignedInDevices() {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      if (list.error) throw new Error(list.error.message ?? "Could not load devices");
      setRows(deviceRows((list.data ?? []) as SessionLike[], current.data?.session.id ?? null));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not load devices");
    }
  }, []);

  useEffect(() => {
    if (authEnabled) void load();
  }, [load]);

  if (!authEnabled) return null;

  const run = async (action: () => Promise<{ error?: { message?: string } | null }>) => {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (result.error) throw new Error(result.error.message ?? "Could not sign out that device");
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not sign out that device");
    } finally {
      setBusy(false);
    }
  };

  const others = rows?.filter((row) => !row.current) ?? [];

  return (
    <div className="border-b border-line py-4">
      <dt className="text-muted">Signed-in devices</dt>
      <dd className="mt-3 flex flex-col gap-3">
        {rows === null && !error ? <p className="text-sm text-muted">Loading…</p> : null}
        {rows?.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{row.device}</p>
              <p className="truncate text-xs text-muted">{row.detail}</p>
            </div>
            {row.current ? null : (
              <button
                type="button"
                disabled={busy}
                aria-label={`Sign out ${row.device}`}
                className="inline-flex h-11 shrink-0 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
                onClick={() => void run(() => authClient.revokeSession({ token: row.token }))}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
        {others.length > 1 ? (
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
            onClick={() => void run(() => authClient.revokeOtherSessions())}
          >
            Sign out all other devices
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-muted">
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
