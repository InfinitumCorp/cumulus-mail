import { useState } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "@/lib/a11y/focus";

/**
 * First run for a new mailbox: a card above the inbox ("Finish setting up") and the dialog it opens.
 * Shown while `settings.setupPending` (written when a real mailbox is first provisioned, seed.ts).
 * Nothing here blocks the app: the card can be dismissed, and every step can be skipped.
 */
export function SetupCard({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <section aria-labelledby="setup-card-title" className="border-b border-line bg-paper px-4 py-4">
      <h2 id="setup-card-title" className="text-base">Finish setting up your mailbox</h2>
      <p className="mt-1 text-sm text-muted">Your name, a signature and your contacts. It takes a minute.</p>
      <div className="mt-3 flex gap-2">
        <button type="button" className="inline-flex h-11 items-center bg-ink px-4 text-sm text-paper" onClick={onOpen}>
          Set up
        </button>
        <button type="button" className="inline-flex h-11 items-center px-4 text-sm text-muted" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}

export type SetupResult = { name: string; signature: string; alias: string };

export function SetupDialog({
  address,
  aliases,
  name,
  signature,
  onDone,
  onClose,
  onImportContacts,
}: {
  address: string;
  aliases: string[];
  name: string;
  signature: string;
  onDone: (result: SetupResult) => void;
  onClose: () => void;
  onImportContacts: () => void;
}) {
  const dialog = useDialogFocus<HTMLDivElement>(true, onClose);
  const [draftName, setDraftName] = useState(name);
  const [draftSignature, setDraftSignature] = useState(signature);
  const [alias, setAlias] = useState("");
  const domain = address.split("@")[1] ?? "";
  return (
    <div className="scrim fixed inset-0 z-40 flex items-end justify-center md:items-center md:p-6" role="presentation" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        className="max-h-dvh w-full overflow-y-auto bg-paper md:max-w-lg md:border md:border-line"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="setup-title" className="text-base">Set up your mailbox</h2>
          <button type="button" className="grid size-11 place-items-center" onClick={onClose} aria-label="Close setup">
            <X className="size-4" />
          </button>
        </div>
        <form
          className="space-y-6 px-5 py-6"
          onSubmit={(event) => {
            event.preventDefault();
            onDone({ name: draftName.trim(), signature: draftSignature, alias: alias.trim().toLowerCase() });
          }}
        >
          <fieldset>
            <legend className="text-sm text-muted">Your address</legend>
            <p className="mt-1 font-mono text-sm" translate="no">{address}</p>
            {aliases.length ? <p className="mt-1 text-sm text-muted">Also yours: <span translate="no">{aliases.join(", ")}</span></p> : null}
            <label htmlFor="setup-alias" className="mt-3 block text-sm">
              Add another address (optional)
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="setup-alias"
                className="h-11 min-w-0 flex-1 border border-line bg-paper px-3"
                value={alias}
                onChange={(event) => setAlias(event.target.value.replace(/@.*$/, ""))}
                autoComplete="off"
                inputMode="email"
                aria-describedby="setup-alias-domain"
              />
              <span id="setup-alias-domain" className="font-mono text-sm text-muted" translate="no">@{domain}</span>
            </div>
          </fieldset>
          <div>
            <label htmlFor="setup-name" className="block text-sm">
              Display name
            </label>
            <input
              id="setup-name"
              className="mt-1 h-11 w-full border border-line bg-paper px-3"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={120}
              autoComplete="name"
            />
            <p className="mt-1 text-sm text-muted">People see this next to your address.</p>
          </div>
          <div>
            <label htmlFor="setup-signature" className="block text-sm">
              Signature
            </label>
            <textarea
              id="setup-signature"
              className="mt-1 min-h-24 w-full border border-line bg-paper p-3"
              value={draftSignature}
              onChange={(event) => setDraftSignature(event.target.value)}
              maxLength={4000}
            />
          </div>
          <div>
            <p className="text-sm">Contacts</p>
            <p className="mt-1 text-sm text-muted">Bring them from Google, Outlook or Apple as vCard or CSV.</p>
            <button type="button" className="mt-2 inline-flex h-11 items-center border border-line px-4 text-sm" onClick={onImportContacts}>
              Go to contacts
            </button>
          </div>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button type="button" className="inline-flex h-11 items-center px-4 text-sm text-muted" onClick={onClose}>
              Skip
            </button>
            <button type="submit" className="inline-flex h-11 items-center bg-ink px-4 text-sm text-paper">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
