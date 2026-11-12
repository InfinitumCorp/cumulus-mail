/**
 * Plans and their limits, in one place (docs/plans.md, step 2). Every limit check reads
 * `limitsFor()` instead of its own constant. Every mailbox starts on "plus", whose limits equal what
 * the code enforced before plans existed, so introducing this changes nothing for anyone.
 * No payment code lives here.
 */
export type PlanId = "free" | "plus" | "pro" | "business";
export type PlanStatus = "active" | "past_due" | "canceled";

export type Limits = {
  /** Storage shown and (later) enforced, in GB. */
  quotaGb: number;
  /** Addresses (aliases) per mailbox. */
  aliases: number;
  /** Custom domains per mailbox. */
  domains: number;
  /** Custom folders per mailbox. */
  folders: number;
  /** Messages per mailbox. Kept at 5,000 on every plan until the snapshot is paged (docs/plans.md). */
  messages: number;
  /** Outside mail through SMTP when the platform has it on. */
  smtp: boolean;
  /** Catch-all on a verified custom domain. */
  catchAll: boolean;
};

export const PLANS: Record<PlanId, Limits> = {
  free: { quotaGb: 1, aliases: 1, domains: 0, folders: 10, messages: 5000, smtp: false, catchAll: false },
  plus: { quotaGb: 15, aliases: 15, domains: 3, folders: 50, messages: 5000, smtp: true, catchAll: true },
  pro: { quotaGb: 50, aliases: 30, domains: 5, folders: 50, messages: 5000, smtp: true, catchAll: true },
  business: { quotaGb: 50, aliases: 30, domains: 10, folders: 50, messages: 5000, smtp: true, catchAll: true },
};

/** The plan every mailbox has until billing exists. Its limits are the pre-plans limits. */
export const DEFAULT_PLAN: PlanId = "plus";

/** Largest value of a limit on any plan: the backstop for sanitizers that run without a plan. */
export function maxLimit(key: "aliases" | "domains" | "folders"): number {
  return Math.max(...Object.values(PLANS).map((limits) => limits[key]));
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/**
 * Limits for a stored plan. An unknown plan id gets the default plan rather than an error, so a bad row
 * never locks anyone out. A canceled subscription falls back to Free. Past-due keeps the plan; the
 * grace period is a billing decision, made when billing exists.
 */
export function limitsFor(planId: unknown, status: unknown = "active"): Limits {
  if (status === "canceled") return PLANS.free;
  return PLANS[isPlanId(planId) ? planId : DEFAULT_PLAN];
}

export type UsageRow = { key: "storage" | "aliases" | "domains" | "folders" | "messages"; label: string; used: number; limit: number; text: string; full: boolean };

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What a mailbox uses against its plan, for the account dialog (docs/plans.md step 5). Storage appears
 * only when the server measured it. `full` marks a limit that is reached (storage: at or over the quota).
 */
export function planUsage(
  limits: Limits,
  used: { aliases: number; domains: number; folders: number; messages: number; usedBytes?: number },
): UsageRow[] {
  const rows: UsageRow[] = [];
  if (typeof used.usedBytes === "number" && Number.isFinite(used.usedBytes)) {
    const gb = used.usedBytes / 1e9;
    rows.push({
      key: "storage",
      label: "Storage",
      used: used.usedBytes,
      limit: limits.quotaGb * 1e9,
      text: `${gb > 0 && gb < 0.01 ? "<0.01" : gb.toFixed(2)} of ${limits.quotaGb} GB`,
      full: gb >= limits.quotaGb,
    });
  }
  const add = (key: UsageRow["key"], label: string, n: number, limit: number) =>
    rows.push({ key, label, used: n, limit, text: `${count(n)} of ${count(limit)}`, full: n >= limit });
  add("aliases", "Addresses", used.aliases, limits.aliases);
  add("domains", "Custom domains", used.domains, limits.domains);
  add("folders", "Folders", used.folders, limits.folders);
  add("messages", "Messages", used.messages, limits.messages);
  return rows;
}

const LABELS: Record<PlanId, string> = { free: "Free", plus: "Plus", pro: "Pro", business: "Business" };

/** The plan name to show, from the same inputs as `limitsFor`, so the name and the limits always agree. */
export function planLabel(planId: unknown, status: unknown = "active"): string {
  if (status === "canceled") return LABELS.free;
  return LABELS[isPlanId(planId) ? planId : DEFAULT_PLAN];
}
