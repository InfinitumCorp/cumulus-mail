import type { ErrorComponentProps } from "@tanstack/react-router";

/**
 * What a person sees when a page fails (500-style) or does not exist (404). Plain words, a way out, and no
 * internals: an error's own message can carry a database or network detail, so it is shown only in
 * development. The text is translated by the interface runtime like any other UI text (src/i18n).
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center text-ink">
      <div className="max-w-md">
        <p className="text-xl tracking-tight" translate="no">
          Cumulus<span className="font-mono text-accent">://</span>Mail
        </p>
        {children}
      </div>
    </main>
  );
}

const PRIMARY = "inline-flex h-11 items-center justify-center bg-ink px-4 text-sm text-paper hover:bg-accent";
const SECONDARY = "inline-flex h-11 items-center justify-center border border-line px-4 text-sm hover:border-ink";

export function AppErrorComponent({ error, reset }: ErrorComponentProps) {
  const detail = import.meta.env.DEV && error instanceof Error ? error.message : "";
  return (
    <Shell>
      <h1 className="mt-6 text-2xl font-medium">Something went wrong</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">This page didn't load. Your mail is safe. Try again in a moment.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          onClick={() => {
            reset();
            window.location.reload();
          }}
        >
          Try again
        </button>
        <a className={SECONDARY} href="/">
          Go to your inbox
        </a>
      </div>
      {detail ? <p className="mt-4 break-words font-mono text-xs text-muted">{detail}</p> : null}
    </Shell>
  );
}

export function AppNotFoundComponent() {
  return (
    <Shell>
      <h1 className="mt-6 text-2xl font-medium">Page not found</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        This address doesn't lead anywhere in Cumulus://Mail. It may have been mistyped, or the link has expired.
      </p>
      <div className="mt-6 flex justify-center">
        <a className={PRIMARY} href="/">
          Go to your inbox
        </a>
      </div>
    </Shell>
  );
}
