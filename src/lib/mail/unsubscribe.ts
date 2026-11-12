import { assertTenantId } from "../storage/adapter.ts";
import { oneClickUnsubscribe, subscriptions, unsubscribeOptions, type Resolver, type Unsubscribe } from "./categories.ts";
import type { MailQuery } from "./query.ts";
import { readMessages, readSettings, writeSettings } from "./records.ts";
import { noteUnsubscribed } from "./settings.ts";

export type UnsubscribeResult =
  | { method: "one-click"; ok: boolean; status: number }
  /** The client finishes these: send the mailto (held like other outside mail) or open the page. */
  | { method: "mailto" | "link"; option: Unsubscribe }
  | { method: "none" };

/**
 * Unsubscribe from the list a stored message came from. The URL is read from
 * the stored message's headers, never from the caller. Only RFC 8058 one-click
 * is performed here; everything else is handed back.
 */
export async function unsubscribeMessage(
  db: MailQuery,
  tenantId: string,
  messageId: string,
  fetcher: typeof fetch = fetch,
  resolve: Resolver | null = null,
): Promise<UnsubscribeResult> {
  assertTenantId(tenantId);
  const messages = await readMessages(db, tenantId);
  const message = messages.find((item) => item.id === messageId);
  if (!message) throw new Error("That message is gone.");
  const option = unsubscribeOptions(message.headers)[0];
  if (!option) return { method: "none" };
  const key = subscriptions([message])[0]?.key ?? message.from.email.toLowerCase();
  if (option.kind !== "one-click") return { method: option.kind, option };
  const result = await oneClickUnsubscribe(option.url, fetcher, 10_000, resolve);
  if (result.ok) {
    const settings = await readSettings(db, tenantId);
    await writeSettings(db, tenantId, noteUnsubscribed(settings, key, "one-click"));
  }
  return { method: "one-click", ...result };
}
