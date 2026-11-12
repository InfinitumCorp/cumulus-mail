/**
 * Which copy of the app is answering: `us` (Cloudflare, Ashburn: everyone outside Russia) or `ru`
 * (Yandex Cloud, ru-central1: ru.* hosts). `MAIL_REGION` wins when set; otherwise a `ru.` host means
 * the Russia copy. Dependency-free.
 */
export type Region = "us" | "ru";

export function regionFor(host: string | null | undefined, env: { MAIL_REGION?: string } = process.env): Region {
  const configured = env.MAIL_REGION?.trim().toLowerCase();
  if (configured === "us" || configured === "ru") return configured;
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return name.startsWith("ru.") ? "ru" : "us";
}
