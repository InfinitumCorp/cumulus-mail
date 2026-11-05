import { createServerFn } from "@tanstack/react-start";

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
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "SCALVS is unavailable right now." };

    const system =
      data.mode === "summary"
        ? "You are SCALVS, the briefing layer inside Cumulus://Mail at Infinitum. Write a tight brief: three short lines of what matters, then one line that starts with Action:. Plain text. No preamble, no markdown headings, no invented facts."
        : "You are SCALVS drafting a reply inside Cumulus://Mail for Alex Reid at Infinitum. Write only the reply body: concise, direct, no subject line, no sign-off block. Do not invent commitments that the thread does not support.";

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 220,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Subject: ${data.subject}\n\n${data.transcript}` },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false as const, error: `SCALVS could not read this thread (${res.status}).` };
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { ok: false as const, error: "SCALVS returned an empty brief." };
    return { ok: true as const, text };
  });
