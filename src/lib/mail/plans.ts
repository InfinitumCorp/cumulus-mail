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
