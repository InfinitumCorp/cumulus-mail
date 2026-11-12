import { useRef, useState } from "react";
import { Paperclip, Sparkles, X } from "lucide-react";
import { bytesToBase64 } from "@/lib/mail/bytes";
import { stubCloudLinks } from "@/lib/mail/cloud-link";
import type { Attachment, CloudLinkRef } from "@/lib/mail/model";
import { formatSize } from "@/lib/mail/logic";

const MAX_FILE = 25 * 1024 * 1024;
const MAX_FILES = 8;

export type DraftForm = {
  draftId?: string;
  threadId?: string;
  placement: "modal" | "inline";
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachments: Attachment[];
  passwordProtected?: boolean;
  password?: string;
  selfDestruct?: boolean;
  requestReceipt?: boolean;
  scheduleAt?: string;
  cloudLinks?: CloudLinkRef[];
};

type Props = {
  form: DraftForm;
  error: string;
  assisting: boolean;
  onChange: (form: DraftForm) => void;
  onSend: () => void;
  onSave: () => void;
  onClose: () => void;
  onAssist: () => void;
};

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-3 border-b border-line px-4">
      <span className="w-14 shrink-0 font-mono text-xs uppercase tracking-wide text-muted">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        autoComplete="off"
      />
    </label>
  );
}

export function Composer({ form, error, assisting, onChange, onSend, onSave, onClose, onAssist }: Props) {
  const title = form.draftId ? "Draft" : form.placement === "inline" ? "Reply" : "New message";
  const picker = useRef<HTMLInputElement>(null);
  const [fileNote, setFileNote] = useState("");

  async function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...form.attachments];
    const links = [...(form.cloudLinks ?? [])];
    let note = "";
    for (const file of list) {
      if (file.size > MAX_FILE) {
        const link = await stubCloudLinks().create({ name: file.name, size: file.size }, 7 * 24 * 60 * 60 * 1000);
        links.push(link);
        note = "Files over 25 MB are a Cumulus://Cloud link. This preview does not upload the bytes.";
        continue;
      }
      if (next.length >= MAX_FILES) {
        note = "Eight files is the limit on a message.";
        break;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      next.push({
        name: file.name,
        size: bytes.byteLength,
        contentType: file.type || "application/octet-stream",
        dataBase64: bytesToBase64(bytes),
      });
    }
    setFileNote(note);
    onChange({ ...form, attachments: next, cloudLinks: links });
    if (picker.current) picker.current.value = "";
  }

  return (
    <form
      className="flex min-h-0 flex-col bg-paper"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-sm">{title}</h2>
        <button type="button" className="grid size-11 place-items-center text-muted hover:text-ink" onClick={onClose} aria-label="Close composer">
          <X className="size-4" />
        </button>
      </div>
      <Field label="To" value={form.to} onChange={(to) => onChange({ ...form, to })} />
      <Field label="Cc" value={form.cc} onChange={(cc) => onChange({ ...form, cc })} />
      <Field label="Subject" value={form.subject} onChange={(subject) => onChange({ ...form, subject })} />
      <textarea
        value={form.body}
        onChange={(event) => onChange({ ...form, body: event.target.value })}
        className="min-h-40 flex-1 resize-none bg-transparent px-4 py-4 text-base leading-normal outline-none"
        placeholder="Write"
        aria-label="Message"
        aria-label="Message"
      />
      {form.attachments.length ? (
        <ul className="flex flex-wrap gap-2 px-4 pb-3">
          {form.attachments.map((file, index) => (
            <li key={`${file.name}-${index}`} className="inline-flex h-9 items-center gap-2 border border-line px-2 text-sm">
              <Paperclip className="size-3.5 text-muted" />
              <span className="max-w-48 truncate">{file.name}</span>
              <span className="font-mono text-xs text-muted">{formatSize(file.size)}</span>
              <button
                type="button"
                className="grid size-7 place-items-center text-muted hover:text-ink"
                aria-label={`Remove ${file.name}`}
                onClick={() => onChange({ ...form, attachments: form.attachments.filter((_, item) => item !== index) })}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {fileNote ? <p className="px-4 pb-2 text-sm">{fileNote}</p> : null}
      {form.cloudLinks?.length ? (
        <ul className="flex flex-wrap gap-2 px-4 pb-3">
          {form.cloudLinks.map((link) => (
            <li key={link.href} className="inline-flex h-9 items-center gap-2 border border-line px-2 text-sm">
              <span className="max-w-48 truncate">{link.name}</span>
              <span className="font-mono text-xs text-muted">{formatSize(link.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="px-4 pb-2 text-sm text-ink">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2">
        <label className="inline-flex h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(form.passwordProtected)}
            onChange={(event) => onChange({ ...form, passwordProtected: event.target.checked })}
          />
          Password
        </label>
        {form.passwordProtected ? (
          <>
            <input
              type="password"
              aria-label="Message password"
              value={form.password ?? ""}
              onChange={(event) => onChange({ ...form, password: event.target.value })}
              className="h-11 w-40 border border-line bg-transparent px-3 text-sm outline-none"
            />
            <label className="inline-flex h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form.selfDestruct)}
                onChange={(event) => onChange({ ...form, selfDestruct: event.target.checked })}
              />
              Self-destruct
            </label>
          </>
        ) : null}
        <label className="inline-flex h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(form.requestReceipt)}
            onChange={(event) => onChange({ ...form, requestReceipt: event.target.checked })}
          />
          Receipt
        </label>
        <label className="inline-flex h-11 items-center gap-2 text-sm">
          Send later
          <input
            type="datetime-local"
            aria-label="Send later"
            value={form.scheduleAt ?? ""}
            onChange={(event) => onChange({ ...form, scheduleAt: event.target.value })}
            className="h-11 border border-line bg-transparent px-2 text-sm"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-3">
        <button type="submit" className="inline-flex h-11 items-center bg-ink px-5 text-sm text-paper transition-colors hover:bg-accent">
          Send
        </button>
        <button type="button" className="inline-flex h-11 items-center border border-line px-4 text-sm hover:border-ink" onClick={onSave}>
          Save draft
        </button>
        <button type="button" className="inline-flex h-11 items-center gap-2 px-3 text-sm hover:text-accent" onClick={() => picker.current?.click()}>
          <Paperclip className="size-4" />
          Drive file
        </button>
        <input ref={picker} type="file" className="sr-only" multiple onChange={(event) => void addFiles(event.target.files)} />
        <button
          type="button"
          className="inline-flex h-11 items-center gap-2 px-3 text-sm text-accent disabled:opacity-50"
          onClick={onAssist}
          disabled={assisting}
        >
          <Sparkles className="size-4" />
          {assisting ? "SCALVS is writing" : "Draft with SCALVS"}
        </button>
      </div>
    </form>
  );
}
