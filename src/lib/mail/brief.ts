import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { completeOpen, hostsFromEnv } from "../ai/open-models";

type BriefMode = "summary" | "draft";

/** The signer's name for a draft: printable, one line, at most 80 characters; else a neutral word. */
export function draftSigner(name: unknown): string {
  const clean = [...String(name ?? "")]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || "the mailbox owner";
}

/**
 * SCALVS brief or draft. Needs a session (authMiddleware) and is rate-limited per user: without that,
 * anyone could use the configured model hosts as a free LLM, at the operator's cost.
 */
export const briefThread = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { mode?: string; subject?: string; transcript?: string; name?: string };
    const mode: BriefMode | null =
      value?.mode === "draft" ? "draft" : value?.mode === "summary" ? "summary" : null;
    if (!mode) throw new Error("Choose a brief or a draft.");
    const transcript = String(value.transcript ?? "").trim().slice(0, 6000);
    if (!transcript) throw new Error("Nothing to read.");
    return { mode, subject: String(value.subject ?? "").slice(0, 200), transcript, name: draftSigner(value.name) };
  })
  .handler(async ({ context, data }) => {
    const { takeAction } = await import("@/lib/rate-limit");
    takeAction(context.userId, "brief");
    const hosts = hostsFromEnv();
    if (!hosts.length) return { ok: false as const, error: "SCALVS is unavailable right now." };

    const system =
      data.mode === "summary"
        ? "You are SCALVS, the briefing layer inside Cumulus://Mail at Infinitum. Write a tight brief: three short lines of what matters, then one line that starts with Action:. Plain text. No preamble, no markdown headings, no invented facts."
        : `You are SCALVS drafting a reply inside Cumulus://Mail for ${data.name}. Write only the reply body: concise, direct, no subject line, no sign-off block. Do not invent commitments that the thread does not support.`;

    let text: string;
    try {
      ({ text } = await completeOpen(hosts, system, `Subject: ${data.subject}

${data.transcript}`, { maxTokens: 400, temperature: 0.3 }));
    } catch {
      return { ok: false as const, error: "SCALVS could not read this thread right now." };
    }
    if (!text) return { ok: false as const, error: "SCALVS returned an empty brief." };
    return { ok: true as const, text };
  });
