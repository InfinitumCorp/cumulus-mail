import { createHmac, timingSafeEqual } from "node:crypto";
import type { MailMessage } from "./model.ts";

export type ImportProvider = "google" | "microsoft";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_LIST = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_LIST = "https://graph.microsoft.com/v1.0/me/messages";

/**
 * Off unless MAIL_PROVIDER_IMPORT=on as well as the provider's client: the provider sends the person
 * back to /api/import/<provider>/callback, and that route does not exist yet (nothing calls
 * readImportState, exchangeCode or listProviderMessages). Until it does, starting an import would only
 * end on a 404 after the person granted access to their mail.
 */
export function importConfigured(provider: ImportProvider, env: Record<string, string | undefined> = process.env): boolean {
  if (env.MAIL_PROVIDER_IMPORT?.trim().toLowerCase() !== "on") return false;
  if (provider === "google") return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
  return Boolean(env.MICROSOFT_CLIENT_ID?.trim() && env.MICROSOFT_CLIENT_SECRET?.trim());
}

function client(provider: ImportProvider, env: Record<string, string | undefined>): { id: string; secret: string } {
  if (provider === "google") return { id: env.GOOGLE_CLIENT_ID?.trim() ?? "", secret: env.GOOGLE_CLIENT_SECRET?.trim() ?? "" };
  return { id: env.MICROSOFT_CLIENT_ID?.trim() ?? "", secret: env.MICROSOFT_CLIENT_SECRET?.trim() ?? "" };
}

function redirectUri(provider: ImportProvider, appHost: string): string {
  return `https://${appHost}/api/import/${provider}/callback`;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function importState(provider: ImportProvider, tenantId: string, secret: string, now = Date.now()): string {
  const payload = `${provider}.${Buffer.from(tenantId).toString("base64url")}.${now + 10 * 60_000}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readImportState(state: string, secret: string, now = Date.now()): { provider: ImportProvider; tenantId: string } | null {
  const [provider, tenant, exp, mac] = state.split(".");
  if ((provider !== "google" && provider !== "microsoft") || !tenant || !exp || !mac) return null;
  const payload = `${provider}.${tenant}.${exp}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < now) return null;
  return { provider, tenantId: Buffer.from(tenant, "base64url").toString() };
}

export function authorizeUrl(provider: ImportProvider, appHost: string, state: string, env: Record<string, string | undefined> = process.env): string {
  const { id } = client(provider, env);
  if (!id) throw new Error(provider === "google" ? "GOOGLE_CLIENT_ID is not set" : "MICROSOFT_CLIENT_ID is not set");
  const url = new URL(provider === "google" ? GOOGLE_AUTH : MS_AUTH);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri(provider, appHost));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", provider === "google" ? "https://www.googleapis.com/auth/gmail.readonly" : "https://graph.microsoft.com/Mail.Read");
  return url.toString();
}

type TokenResponse = { access_token?: string };

export async function exchangeCode(
  provider: ImportProvider,
  code: string,
  appHost: string,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch,
): Promise<string> {
  const { id, secret } = client(provider, env);
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(provider, appHost),
  });
  const response = await fetcher(provider === "google" ? GOOGLE_TOKEN : MS_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("The provider refused the code");
  const json = (await response.json()) as TokenResponse;
  if (!json.access_token) throw new Error("The provider returned no token");
  return json.access_token;
}

function messageFrom(id: string, from: string, to: string, subject: string, body: string, at: string): MailMessage {
  const person = (value: string) => {
    const email = /[\w.+-]+@[\w.-]+/.exec(value)?.[0]?.toLowerCase() ?? "imported@localhost";
    const name = value.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || email;
    return { name: name.slice(0, 200), email };
  };
  return {
    id: `imp-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`,
    threadId: `imp-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`,
    folder: "inbox",
    from: person(from),
    to: [person(to || "me@localhost")],
    cc: [],
    subject: subject.slice(0, 500) || "(no subject)",
    body: body.slice(0, 100_000),
    at: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString(),
    unread: true,
    starred: false,
    labels: ["Imported"],
  };
}

export function messagesFromGmail(pages: Array<{ id?: string; payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string } } }>): MailMessage[] {
  return pages.flatMap((page) => {
    if (!page.id) return [];
    const headers = new Map((page.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
    const data = page.payload?.body?.data;
    const body = data ? Buffer.from(data, "base64url").toString("utf8") : "";
    return [messageFrom(page.id, headers.get("from") ?? "", headers.get("to") ?? "", headers.get("subject") ?? "", body, headers.get("date") ?? "")];
  });
}

export function messagesFromGraph(rows: Array<{ id?: string; from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; bodyPreview?: string; receivedDateTime?: string }>): MailMessage[] {
  return rows.flatMap((row) => {
    if (!row.id) return [];
    const from = row.from?.emailAddress;
    return [messageFrom(row.id, `${from?.name ?? ""} <${from?.address ?? ""}>`, "", row.subject ?? "", row.bodyPreview ?? "", row.receivedDateTime ?? "")];
  });
}

export async function listProviderMessages(provider: ImportProvider, accessToken: string, fetcher: typeof fetch): Promise<MailMessage[]> {
  if (provider === "google") {
    const list = await fetcher(`${GOOGLE_LIST}?maxResults=20`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!list.ok) throw new Error("Gmail refused the mailbox read");
    const ids = ((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? [];
    const pages = [];
    for (const item of ids.slice(0, 20)) {
      const one = await fetcher(`${GOOGLE_LIST}/${item.id}?format=full`, { headers: { authorization: `Bearer ${accessToken}` } });
      if (one.ok) pages.push((await one.json()) as Parameters<typeof messagesFromGmail>[0][number]);
    }
    return messagesFromGmail(pages);
  }
  const list = await fetcher(`${MS_LIST}?$top=20&$select=id,subject,bodyPreview,from,receivedDateTime`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok) throw new Error("Outlook refused the mailbox read");
  const rows = ((await list.json()) as { value?: Parameters<typeof messagesFromGraph>[0] }).value ?? [];
  return messagesFromGraph(rows);
}
