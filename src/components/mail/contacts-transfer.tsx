import { useState } from "react";
import { mergeContacts, parseContactsFile, toVCards } from "@/lib/mail/contacts-io";
import type { Contact } from "@/lib/mail/model";

/**
 * Import contacts from a vCard (.vcf) or CSV file (Google Contacts, Outlook, or name/email columns),
 * and export them all as vCard 4.0. Runs in the browser: the merged list is saved with the mailbox like
 * any other edit. Import fills gaps and never overwrites what is already there.
 */
export function ContactsTransfer({ contacts, onReplace }: { contacts: Contact[]; onReplace: (contacts: Contact[]) => void }) {
  const [note, setNote] = useState("");

  const importFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setNote("That file is over 5 MB. Split it and import the parts.");
      return;
    }
    try {
      const incoming = parseContactsFile(file.name, await file.text());
      const { contacts: next, report } = mergeContacts(contacts, incoming, () => `c-${crypto.randomUUID()}`);
      onReplace(next);
      const parts = [
        `${report.added} added`,
        `${report.updated} updated`,
        report.unchanged ? `${report.unchanged} already up to date` : "",
        report.skipped ? `${report.skipped} without an email skipped` : "",
      ].filter(Boolean);
      setNote(`Imported: ${parts.join(", ")}.`);
    } catch {
      setNote("Could not read that file.");
    }
  };

  const exportAll = () => {
    const blob = new Blob([toVCards(contacts)], { type: "text/vcard;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cumulus-contacts-${new Date().toISOString().slice(0, 10)}.vcf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mt-6 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center border border-line px-3 text-sm hover:border-ink focus-within:border-ink">
          Import contacts
          <input
            type="file"
            accept=".vcf,.vcard,.csv,text/vcard,text/csv"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </label>
        <button
          type="button"
          disabled={contacts.length === 0}
          onClick={exportAll}
          className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
        >
          Export vCard
        </button>
      </div>
      <p className="text-xs text-muted">vCard (.vcf) or CSV from Google Contacts, Outlook or Apple. Existing details are kept.</p>
      {note ? (
        <p role="status" className="text-xs text-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}
