import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * @conjure in Cumulus://Mail: write "@conjure <question>" in a draft and press Assist.
 * The hosted Conjure service runs a live forecast; the draft gets the result.
 * Needs CONJURE_URL and CONJURE_PRODUCT_KEY on the server (the key never reaches the browser).
 */
async function routes() {
  const { conjureRoutesFromEnv } = await import("../../../server/conjure/conjure.mjs");
  return conjureRoutesFromEnv(process.env, { prefix: "/conjure", source: "mail" });
}

type ConjureReply = { mention?: boolean; text?: string; ticket?: string | null; prediction?: { status: string } | null; error?: string };

async function call(request: Request, user: string): Promise<ConjureReply> {
  const res = await (await routes())(request, { user });
  if (!res) return { error: "Conjure is unavailable." };
  const body = (await res.json()) as ConjureReply;
  return res.ok ? body : { error: body.error || "Conjure is unavailable right now." };
}

export const startConjure = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const value = input as { text?: string; context?: string };
    const text = String(value?.text ?? "").slice(0, 8000);
    if (!text.trim()) throw new Error("Write @conjure and a question.");
    return { text, context: String(value?.context ?? "").slice(0, 20000) };
  })
  .handler(async ({ data, context }) =>
    call(new Request("https://mail.local/conjure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: data.text, context: data.context, source: "mail" }) }), context.userId),
  );

export const followConjure = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const ticket = String((input as { ticket?: string })?.ticket ?? "");
    if (!/^[\w-]+\.[\w-]+$/.test(ticket)) throw new Error("Unknown forecast.");
    return { ticket };
  })
  .handler(async ({ data, context }) => call(new Request(`https://mail.local/conjure/${data.ticket}`), context.userId));
