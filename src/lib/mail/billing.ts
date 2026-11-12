/**
 * Stripe billing (docs/plans.md §5, step 4). No SDK: Stripe's REST API takes form-encoded requests,
 * and the webhook signature is an HMAC, so plain `fetch` and `node:crypto` work on Node and on
 * Workers alike.
 *
 * Keys come only from the environment (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`), set by the owner
 * in the platform's secret store. Without them billing is off and the rest of the app is unchanged.
 * Code refers to prices by `lookup_key` (`plus_monthly`, ...), never by price id, so prices can change
 * in the Stripe dashboard without a deploy.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { applyWorkerBindings } from "../cloudflare-env.ts";
import { openText } from "./field-crypto.ts";
import type { MailQuery } from "./query.ts";
import { isPlanId, limitsFor, type PlanId, type PlanStatus } from "./plans.ts";
import { BILLING_OFF, type BillingStatus } from "./billing-status.ts";

/** Display name stored in `mailboxes.plan` (shown in the account dialog). */
export const PLAN_LABELS: Record<PlanId, string> = { free: "Free", plus: "Plus", pro: "Pro", business: "Business" };

export type StripeConfig = { secretKey: string; webhookSecret: string | null };

type BillingEnv = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

export function stripeConfig(env?: BillingEnv): StripeConfig | null {
  // On Workers the keys are bindings; copy them into process.env before the first read, which can
  // come before anything has opened the database (the webhook checks this first).
  if (!env) {
    applyWorkerBindings();
    env = process.env;
  }
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return { secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null };
}

/** Paid plans and intervals people can pick. Free has no price. */
export const PRICE_LOOKUP_KEYS = [
  "plus_monthly",
  "plus_yearly",
  "pro_monthly",
  "pro_yearly",
  "business_monthly",
  "business_yearly",
] as const;
export type PriceLookupKey = (typeof PRICE_LOOKUP_KEYS)[number];

export function isPriceLookupKey(value: unknown): value is PriceLookupKey {
  return typeof value === "string" && (PRICE_LOOKUP_KEYS as readonly string[]).includes(value);
}

/** `pro_yearly` -> `pro`. Anything not on the list -> null. */
export function planFromLookupKey(key: unknown): PlanId | null {
  if (!isPriceLookupKey(key)) return null;
  const plan = key.split("_")[0];
  return isPlanId(plan) ? plan : null;
}

/** Stripe subscription status -> the three states the limits understand. */
export function planStatusFromStripe(status: unknown): PlanStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      // past_due, unpaid, incomplete, paused: keep the plan for now; grace is an owner decision.
      return "past_due";
  }
}

// ---------------------------------------------------------------- webhook signature

export class StripeSignatureError extends Error {}

/**
 * Verify a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=...]`) against the raw request body.
 * Rejects a missing or malformed header, a timestamp outside `toleranceSeconds`, and any mismatch.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): void {
  if (!header) throw new StripeSignatureError("Missing Stripe-Signature header");
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new StripeSignatureError("Malformed Stripe-Signature header");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - Number(timestamp)) > tolerance) throw new StripeSignatureError("Stripe signature is too old");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex"));
  const match = signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) throw new StripeSignatureError("Stripe signature does not match");
}

/** Build a header the way Stripe does. For tests and local fixtures. */
export function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

// ---------------------------------------------------------------- REST client

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Stripe's bracket form encoding: `a[b]=1`, `a[0][c]=2`. */
export function stripeForm(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const add = (key: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => add(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else out.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return out.toString();
}

export type StripeClient = (
  method: "GET" | "POST",
  path: string,
  params?: Record<string, FormValue>,
  options?: { idempotencyKey?: string },
) => Promise<Record<string, unknown>>;

export function stripeClient(secretKey: string, fetcher: typeof fetch = fetch): StripeClient {
  return async (method, path, params = {}, options = {}) => {
    const body = stripeForm(params);
    const url = `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await fetcher(url, { method, headers, body: method === "POST" ? body : undefined });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = json.error as { message?: string } | undefined;
      throw new Error(`Stripe ${method} ${path} failed: ${error?.message ?? `HTTP ${response.status}`}`);
    }
    return json;
  };
}

// ---------------------------------------------------------------- checkout and portal

async function priceIdFor(stripe: StripeClient, lookupKey: PriceLookupKey): Promise<string> {
  const list = await stripe("GET", "/v1/prices", { lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = (list.data as Array<{ id?: string }> | undefined)?.[0];
  if (!price?.id) throw new Error(`No active Stripe price has lookup_key ${lookupKey}`);
  return price.id;
}

async function mailboxBilling(db: MailQuery, tenantId: string) {
  const rows = await db.query<{
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    plan_status: string;
    address: string | null;
  }>(
    `select stripe_customer_id, stripe_subscription_id, plan_status, address from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  const box = rows[0];
  if (!box) throw new Error("Mailbox not found");
  // The address is sealed at rest; Stripe gets the plain address for receipts.
  return {
    stripe_customer_id: box.stripe_customer_id,
    subscribed: Boolean(box.stripe_subscription_id) && box.plan_status !== "canceled",
    address: box.address ? openText(tenantId, box.address) : null,
  };
}

export const ALREADY_SUBSCRIBED = "You already have a plan. Use Manage billing to change it.";

/** Any subscription on the customer that is not over yet (active, trialing, past due, unpaid, incomplete). */
async function hasLiveSubscription(stripe: StripeClient, customer: string): Promise<boolean> {
  const list = await stripe("GET", "/v1/subscriptions", { customer, status: "all", limit: 10 });
  const subs = (list.data as Array<{ status?: unknown }> | undefined) ?? [];
  return subs.some((sub) => sub.status !== "canceled" && sub.status !== "incomplete_expired");
}

/** The mailbox's Stripe customer, created (and stored) on first use. */
async function ensureCustomer(db: MailQuery, stripe: StripeClient, tenantId: string): Promise<string> {
  const box = await mailboxBilling(db, tenantId);
  if (box.stripe_customer_id) return box.stripe_customer_id;
  const customer = await stripe(
    "POST",
    "/v1/customers",
    { email: box.address ?? undefined, metadata: { tenant_id: tenantId } },
    { idempotencyKey: `customer-${tenantId}` },
  );
  const id = String(customer.id ?? "");
  if (!id) throw new Error("Stripe returned no customer id");
  // Only fill an empty column, so a concurrent first checkout cannot replace the stored customer.
  const rows = await db.query<{ stripe_customer_id: string }>(
    `update cumulus_mail.mailboxes set stripe_customer_id = coalesce(stripe_customer_id, $2)
      where tenant_id = $1 returning stripe_customer_id`,
    [tenantId, id],
  );
  return rows[0]?.stripe_customer_id ?? id;
}

/** Start a subscription Checkout for this mailbox. Returns the URL to send the browser to. */
export async function startCheckout(
  db: MailQuery,
  stripe: StripeClient,
  input: { tenantId: string; lookupKey: unknown; returnUrl: string },
): Promise<{ url: string }> {
  if (!isPriceLookupKey(input.lookupKey)) throw new Error("Unknown plan");
  // One subscription per mailbox: a second Checkout would bill twice. Plan changes go through the
  // Portal. Stripe is asked too, since the webhook for a just-finished Checkout may not have arrived.
  const box = await mailboxBilling(db, input.tenantId);
  if (box.subscribed || (box.stripe_customer_id && (await hasLiveSubscription(stripe, box.stripe_customer_id)))) {
    throw new Error(ALREADY_SUBSCRIBED);
  }
  const price = await priceIdFor(stripe, input.lookupKey);
  const customer = await ensureCustomer(db, stripe, input.tenantId);
  const session = await stripe("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: input.tenantId,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { tenant_id: input.tenantId } },
    success_url: `${input.returnUrl}?billing=success`,
    cancel_url: `${input.returnUrl}?billing=canceled`,
  });
  if (typeof session.url !== "string") throw new Error("Stripe returned no Checkout URL");
  return { url: session.url };
}

/** Stripe's Customer Portal (change plan, card, cancel, invoices). Needs a customer from a checkout. */
export async function openBillingPortal(
  db: MailQuery,
  stripe: StripeClient,
  input: { tenantId: string; returnUrl: string },
): Promise<{ url: string }> {
  const box = await mailboxBilling(db, input.tenantId);
  if (!box.stripe_customer_id) throw new Error("No billing account yet. Choose a plan first.");
  const session = await stripe("POST", "/v1/billing_portal/sessions", {
    customer: box.stripe_customer_id,
    return_url: input.returnUrl,
  });
  if (typeof session.url !== "string") throw new Error("Stripe returned no portal URL");
  return { url: session.url };
}

// ---------------------------------------------------------------- webhook events

export type StripeEvent = { id: string; type: string; created?: number; data: { object: Record<string, unknown> } };

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export function parseStripeEvent(payload: string): StripeEvent {
  const event = JSON.parse(payload) as Partial<StripeEvent>;
  if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    throw new Error("Not a Stripe event");
  }
  return event as StripeEvent;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** Stripe expands some ids to objects; accept either. */
const idOf = (value: unknown): string | null =>
  str(value) ?? (value && typeof value === "object" ? str((value as { id?: unknown }).id) : null);

type SubscriptionFields = {
  customer: string | null;
  tenantId: string | null;
  subscriptionId: string | null;
  planId: PlanId | null;
  status: PlanStatus;
  renewsAt: Date | null;
};

export function readSubscription(object: Record<string, unknown>): SubscriptionFields {
  const items = (object.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  const first = items[0] ?? {};
  const price = first.price as { lookup_key?: unknown } | undefined;
  // `current_period_end` moved from the subscription to its items in newer API versions.
  const periodEnd = Number(first.current_period_end ?? object.current_period_end);
  const metadata = (object.metadata as Record<string, unknown> | undefined) ?? {};
  return {
    customer: idOf(object.customer),
    tenantId: str(metadata.tenant_id),
    subscriptionId: str(object.id),
    planId: planFromLookupKey(price?.lookup_key),
    status: planStatusFromStripe(object.status),
    renewsAt: Number.isFinite(periodEnd) && periodEnd > 0 ? new Date(periodEnd * 1000) : null,
  };
}

export type EventOutcome = "applied" | "duplicate" | "ignored";

/**
 * Apply one verified event. The event id goes into `billing_events` first, so a redelivery is a no-op;
 * if applying fails the id is removed again so Stripe's retry gets another go.
 */
/**
 * Stripe does not deliver events in order, so a late `updated` could undo a newer one. With a client,
 * subscription state is re-read from Stripe when the event arrives (Stripe's recommended pattern) and
 * the payload is used only to find the subscription. Without one (tests, or no key), the payload is used.
 */
async function currentSubscription(
  stripe: StripeClient | undefined,
  id: string | null,
): Promise<Record<string, unknown> | null> {
  if (!stripe || !id || !/^sub_[A-Za-z0-9]+$/.test(id)) return null;
  return stripe("GET", `/v1/subscriptions/${id}`);
}

/** The subscription an invoice belongs to (top-level in older API versions, under `parent` in newer). */
function invoiceSubscription(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idOf(invoice.subscription) ?? idOf(parent?.subscription_details?.subscription);
}

export async function handleStripeEvent(db: MailQuery, event: StripeEvent, stripe?: StripeClient): Promise<EventOutcome> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) return "ignored";
  const claimed = await db.query(
    `insert into cumulus_mail.billing_events (id, type) values ($1, $2) on conflict (id) do nothing returning id`,
    [event.id, event.type],
  );
  if (claimed.length === 0) return "duplicate";
  try {
    return await applyEvent(db, event, stripe);
  } catch (error) {
    await db.query(`delete from cumulus_mail.billing_events where id = $1`, [event.id]);
    throw error;
  }
}

async function applyEvent(db: MailQuery, event: StripeEvent, stripe?: StripeClient): Promise<EventOutcome> {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const tenantId = str(object.client_reference_id);
      const customer = idOf(object.customer);
      if (!tenantId || !customer || object.mode !== "subscription") return "ignored";
      // Bind the customer only to the mailbox that started the checkout, and never overwrite another one.
      const rows = await db.query(
        `update cumulus_mail.mailboxes
            set stripe_customer_id = coalesce(stripe_customer_id, $2),
                stripe_subscription_id = coalesce($3, stripe_subscription_id)
          where tenant_id = $1 and (stripe_customer_id is null or stripe_customer_id = $2)
          returning tenant_id`,
        [tenantId, customer, idOf(object.subscription)],
      );
      return rows.length ? "applied" : "ignored";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const fresh = event.type === "customer.subscription.deleted" ? null : await currentSubscription(stripe, str(object.id));
      const sub = readSubscription(fresh ?? object);
      if (!sub.customer) return "ignored";
      const deleted = event.type === "customer.subscription.deleted" || (fresh !== null && sub.status === "canceled");
      const status: PlanStatus = deleted ? "canceled" : sub.status;
      // The label and quota shown in the account dialog follow the limits now in force.
      const shown: PlanId | null = status === "canceled" ? "free" : sub.planId;
      // A price without a known lookup key keeps the stored plan rather than guessing.
      const rows = await db.query(
        `update cumulus_mail.mailboxes
            set stripe_customer_id = coalesce(stripe_customer_id, $1),
                plan_id = coalesce($3, plan_id),
                plan_status = $4,
                plan_renews_at = $5,
                stripe_subscription_id = $6,
                plan = coalesce($9, plan),
                quota_gb = coalesce($10, quota_gb)
          where (stripe_customer_id = $1 or (stripe_customer_id is null and tenant_id = $2))
            and (stripe_subscription_id is null or stripe_subscription_id = $7 or $8)
          returning tenant_id`,
        [
          sub.customer,
          sub.tenantId,
          sub.planId,
          status,
          deleted ? null : sub.renewsAt,
          deleted ? null : sub.subscriptionId,
          sub.subscriptionId,
          // A new subscription replaces a canceled one; an update for a stale subscription does not.
          event.type === "customer.subscription.created",
          shown ? PLAN_LABELS[shown] : null,
          shown ? limitsFor(shown).quotaGb : null,
        ],
      );
      return rows.length ? "applied" : "ignored";
    }
    case "invoice.payment_failed": {
      const customer = idOf(object.customer);
      if (!customer) return "ignored";
      // Re-read the subscription: a failure reported after the card was fixed must not mark it past due.
      const fresh = await currentSubscription(stripe, invoiceSubscription(object));
      if (fresh && planStatusFromStripe(fresh.status) === "active") return "ignored";
      const rows = await db.query(
        `update cumulus_mail.mailboxes set plan_status = 'past_due'
          where stripe_customer_id = $1 and plan_status = 'active' returning tenant_id`,
        [customer],
      );
      return rows.length ? "applied" : "ignored";
    }
    default:
      return "ignored";
  }
}

// ---------------------------------------------------------------- status for the account dialog

export { BILLING_OFF, billingNotice, type BillingStatus } from "./billing-status.ts";

export async function billingStatus(db: MailQuery, tenantId: string): Promise<BillingStatus> {
  const rows = await db.query<{
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    plan_status: string;
    plan_renews_at: Date | string | null;
  }>(
    `select stripe_customer_id, stripe_subscription_id, plan_status, plan_renews_at
       from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return { ...BILLING_OFF, enabled: true };
  const planStatus: PlanStatus =
    row.plan_status === "past_due" || row.plan_status === "canceled" ? row.plan_status : "active";
  const renews = row.plan_renews_at ? new Date(row.plan_renews_at) : null;
  return {
    enabled: true,
    subscribed: Boolean(row.stripe_subscription_id) && planStatus !== "canceled",
    hasCustomer: Boolean(row.stripe_customer_id),
    planStatus,
    renewsAt: renews && !Number.isNaN(renews.getTime()) ? renews.toISOString() : null,
  };
}
