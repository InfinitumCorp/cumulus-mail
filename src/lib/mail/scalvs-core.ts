/**
 * The @scalvs call itself, server side (no framework imports, so it is testable with node --test).
 *
 *   @conjure <question>          a live Conjure™ forecast (see conjure.ts)
 *   @scalvs / @scalus <task>     the SCALVS agent, which runs on an OpenClaw gateway
 *
 * "@openclaw" is not a trigger. The gateway token stays on the server.
 */
import { openClawRoutesFromEnv } from "../../../server/openclaw/openclaw.mjs";

export type ScalvsReply = { mention?: boolean; text?: string; agent?: string; error?: string };

/** Sends the draft's @scalvs task to the SCALVS agent for this signed-in person. */
export async function askScalvsFor(
  env: Record<string, string | undefined>,
  input: { text: string; context?: string; user: string },
  options: { fetch?: typeof fetch } = {},
): Promise<ScalvsReply> {
  const routes = openClawRoutesFromEnv(env, { product: "mail", prefix: "/scalvs", fetch: options.fetch });
  const res = await routes(
    new Request("https://mail.local/scalvs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input.text, context: input.context }) }),
    { user: input.user },
  );
  if (!res) return { error: "SCALVS is unavailable." };
  const body = (await res.json()) as ScalvsReply;
  return res.ok ? body : { error: body.error || "SCALVS is unavailable right now." };
}
