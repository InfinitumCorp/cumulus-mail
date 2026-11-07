import { createServerFn } from "@tanstack/react-start";
import { completeOpen, hostsFromEnv } from "../ai/open-models";

type BriefMode = "summary" | "draft";

export const briefThread = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = input as { mode?: string; subject?: string; transcript?: string };
    const mode: BriefMode | null =
      value?.mode === "draft" ? "draft" : value?.mode === "summary" ? "summary" : null;
    if (!mode) throw new Error("Choose a brief or a draft.");
    const transcript = String(value.transcript ?? "").trim().slice(0, 6000);
    if (!transcript) throw new Error("Nothing to read.");
    return { mode, subject: String(value.subject ?? "").slice(0, 200), transcript };
  })
  .handler(async ({ data }) => {
    const hosts = hostsFromEnv();
    if (!hosts.length) return { ok: false as const, error: "SCALVS is unavailable right now." };

    const system =
      data.mode === "summary"
        ? "You are SCALVS, the briefing layer inside Cumulus://Mail at Infinitum. Write a tight brief: three short lines of what matters, then one line that starts with Action:. Plain text. No preamble, no markdown headings, no invented facts."
        : "You are SCALVS drafting a reply inside Cumulus://Mail for Alex Reid at Infinitum. Write only the reply body: concise, direct, no subject line, no sign-off block. Do not invent commitments that the thread does not support.";

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
