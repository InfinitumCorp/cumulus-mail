import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { burnProtectedLink, fetchProtectedLink } from "@/lib/mail/api";
import type { ProtectedEnvelope } from "@/lib/mail/model";
import { openWithPassword } from "@/lib/mail/protect";

export const Route = createFileRoute("/p/$token")({
  component: ProtectedPage,
});

function ProtectedPage() {
  const { token } = Route.useParams();
  const [password, setPassword] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [envelope, setEnvelope] = useState<ProtectedEnvelope | null>(null);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const sealed = envelope ?? (await fetchProtectedLink({ data: { token } })).envelope;
      setEnvelope(sealed);
      const text = await openWithPassword(sealed, password);
      setBody(text);
      await burnProtectedLink({ data: { token } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open this message.");
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-5">
      <p className="font-mono text-xs uppercase tracking-wide text-accent">Cumulus://Mail</p>
      <h1 className="mt-4 text-4xl tracking-tight">Password-protected message</h1>
      {body ? (
        <p className="mt-6 whitespace-pre-wrap text-base leading-normal">{body}</p>
      ) : (
        <form className="mt-6 flex flex-col gap-3" onSubmit={(event) => void unlock(event)}>
          <p className="text-sm text-muted">The password stays in this browser. The server stores only the sealed message.</p>
          <input
            type="password"
            aria-label="Message password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 border border-line bg-transparent px-3 text-sm outline-none"
          />
          <button type="submit" className="inline-flex h-11 items-center self-start bg-ink px-4 text-sm text-paper">
            Unlock
          </button>
          {error ? <p className="text-sm">{error}</p> : null}
        </form>
      )}
    </main>
  );
}
