/**
 * Who may run the scheduled jobs over HTTP (`POST /api/cron/tick`). Off unless `CRON_SECRET` is set
 * (32+ characters); then the caller must send `Authorization: Bearer <CRON_SECRET>`. Compared in
 * constant time. Used by the Russia copy, whose scheduler is a Yandex timer or a VM cron; the US copy
 * runs the same jobs from the inbound worker's Cloudflare cron.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type CronDecision = "off" | "denied" | "allowed";

export function cronDecision(authorization: string | null | undefined, env: { CRON_SECRET?: string } = process.env): CronDecision {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || secret.length < 32) return "off";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return "denied";
  // Hash both so the comparison is constant-time whatever the lengths.
  const given = createHash("sha256").update(match[1]!).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected) ? "allowed" : "denied";
}
