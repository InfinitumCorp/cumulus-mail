import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  StripeSignatureError,
  handleStripeEvent,
  openBillingPortal,
  parseStripeEvent,
  planFromLookupKey,
  planStatusFromStripe,
  signStripePayload,
  startCheckout,
  stripeClient,
  stripeConfig,
  stripeForm,
  verifyStripeSignature,
  type StripeClient,
  type StripeEvent,
} from "./billing.ts";
import { openMailbox } from "./mailbox.ts";
import { limitsFor, PLANS } from "./plans.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

async function row(tenantId: string) {
  const rows = await harness.db.query<{
    plan_id: string;
    plan_status: string;
    plan_renews_at: Date | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }>(
    `select plan_id, plan_status, plan_renews_at, stripe_customer_id, stripe_subscription_id
       from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]!;
}

const event = (id: string, type: string, object: Record<string, unknown>): StripeEvent => ({
  id,
  type,
  data: { object },
});

const subscription = (id: string, customer: string, lookupKey: string, status = "active", extra = {}) => ({
  id,
  object: "subscription",
  customer,
  status,
  metadata: {},
  items: { data: [{ price: { id: `price_${lookupKey}`, lookup_key: lookupKey }, current_period_end: 1_800_000_000 }] },
  ...extra,
});

/** A Stripe stand-in that records calls and answers like the real API. */
function fakeStripe() {
  const calls: Array<{ method: string; path: string; params: Record<string, unknown>; key?: string }> = [];
  let customers = 0;
  const stripe: StripeClient = async (method, path, params = {}, options = {}) => {
    calls.push({ method, path, params, key: options.idempotencyKey });
    if (path === "/v1/prices") {
      const key = (params.lookup_keys as string[])[0];
      return { data: key === "pro_yearly" ? [] : [{ id: `price_${key}` }] };
    }
    if (path === "/v1/customers") return { id: `cus_${++customers}` };
    if (path === "/v1/checkout/sessions") return { url: "https://checkout.stripe.com/c/pay/cs_test_1" };
    if (path === "/v1/billing_portal/sessions") return { url: "https://billing.stripe.com/p/session/test_1" };
    throw new Error(`unexpected ${path}`);
  };
  return { stripe, calls };
}

test("billing is off without a secret key, and the webhook secret is optional config", () => {
  assert.equal(stripeConfig({}), null);
  assert.equal(stripeConfig({ STRIPE_SECRET_KEY: "  " }), null);
  assert.deepEqual(stripeConfig({ STRIPE_SECRET_KEY: " sk_test_x " }), { secretKey: "sk_test_x", webhookSecret: null });
  assert.deepEqual(stripeConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_y" }), {
    secretKey: "sk_test_x",
    webhookSecret: "whsec_y",
  });
});

test("lookup keys map to plans and Stripe statuses map to the three plan states", () => {
  assert.equal(planFromLookupKey("plus_monthly"), "plus");
  assert.equal(planFromLookupKey("business_yearly"), "business");
  assert.equal(planFromLookupKey("free_monthly"), null);
  assert.equal(planFromLookupKey("enterprise_monthly"), null);
  assert.equal(planFromLookupKey(undefined), null);
  assert.equal(planStatusFromStripe("trialing"), "active");
  assert.equal(planStatusFromStripe("past_due"), "past_due");
  assert.equal(planStatusFromStripe("unpaid"), "past_due");
  assert.equal(planStatusFromStripe("incomplete_expired"), "canceled");
});

test("webhook signatures: valid, tampered, wrong secret, stale and malformed", () => {
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: {} } });
  const now = 1_763_000_000;
  const header = signStripePayload(body, "whsec_test", now);
  verifyStripeSignature(body, header, "whsec_test", { now });
  // Stripe sends one v1 per active secret during a rotation; any match is enough.
  verifyStripeSignature(body, `${header},v1=${"0".repeat(64)}`, "whsec_test", { now });
  assert.throws(() => verifyStripeSignature(`${body} `, header, "whsec_test", { now }), StripeSignatureError);
  assert.throws(() => verifyStripeSignature(body, header, "whsec_other", { now }), /does not match/);
  assert.throws(() => verifyStripeSignature(body, header, "whsec_test", { now: now + 301 }), /too old/);
  assert.throws(() => verifyStripeSignature(body, null, "whsec_test", { now }), /Missing/);
  assert.throws(() => verifyStripeSignature(body, "v1=abc", "whsec_test", { now }), /Malformed/);
  assert.throws(() => verifyStripeSignature(body, `t=${now}`, "whsec_test", { now }), /Malformed/);
  assert.throws(() => parseStripeEvent("{}"), /Not a Stripe event/);
});

test("form encoding uses Stripe's bracket syntax", () => {
  assert.equal(
    decodeURIComponent(stripeForm({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], metadata: { tenant_id: "t" }, skip: undefined })),
    "mode=subscription&line_items[0][price]=p&line_items[0][quantity]=1&metadata[tenant_id]=t",
  );
});

test("the REST client sends the key as a bearer token and surfaces Stripe's error message", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = stripeClient("sk_test_key", (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (url.includes("/v1/prices")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "No such customer" } }), { status: 400 });
  }) as unknown as typeof fetch);
  await client("GET", "/v1/prices", { lookup_keys: ["plus_monthly"] });
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/prices?lookup_keys%5B0%5D=plus_monthly");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer sk_test_key");
  await assert.rejects(() => client("POST", "/v1/billing_portal/sessions", { customer: "x" }, { idempotencyKey: "k" }), /No such customer/);
  assert.equal((seen[1]!.init.headers as Record<string, string>)["idempotency-key"], "k");
});

test("checkout creates the customer once, by lookup key, scoped to the calling mailbox", async () => {
  await openMailbox(harness.db, "bill-ada", profile("bill-ada", "bill.ada@cumuluscloud.app", "Ada"));
  const { stripe, calls } = fakeStripe();
  const returnUrl = "https://mail.cumuluscloud.app/";

  const first = await startCheckout(harness.db, stripe, { tenantId: "bill-ada", lookupKey: "pro_monthly", returnUrl });
  assert.equal(first.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const session = calls.find((c) => c.path === "/v1/checkout/sessions")!;
  assert.equal(session.params.mode, "subscription");
  assert.equal(session.params.customer, "cus_1");
  assert.equal(session.params.client_reference_id, "bill-ada");
  assert.deepEqual(session.params.line_items, [{ price: "price_pro_monthly", quantity: 1 }]);
  assert.deepEqual(session.params.subscription_data, { metadata: { tenant_id: "bill-ada" } });
  const customer = calls.find((c) => c.path === "/v1/customers")!;
  assert.equal(customer.key, "customer-bill-ada");
  // The sealed address is opened before it reaches Stripe.
  assert.equal(customer.params.email, "bill.ada@cumuluscloud.app");
  assert.deepEqual(customer.params.metadata, { tenant_id: "bill-ada" });
  assert.equal((await row("bill-ada")).stripe_customer_id, "cus_1");
  // Nothing about the plan changes until Stripe says the subscription exists.
  assert.equal((await row("bill-ada")).plan_id, "plus");

  await startCheckout(harness.db, stripe, { tenantId: "bill-ada", lookupKey: "plus_yearly", returnUrl });
  assert.equal(calls.filter((c) => c.path === "/v1/customers").length, 1);

  await assert.rejects(() => startCheckout(harness.db, stripe, { tenantId: "bill-ada", lookupKey: "free", returnUrl }), /Unknown plan/);
  await assert.rejects(
    () => startCheckout(harness.db, stripe, { tenantId: "bill-ada", lookupKey: "pro_yearly", returnUrl }),
    /No active Stripe price/,
  );

  const portal = await openBillingPortal(harness.db, stripe, { tenantId: "bill-ada", returnUrl });
  assert.equal(portal.url, "https://billing.stripe.com/p/session/test_1");
  assert.equal(calls.at(-1)!.params.customer, "cus_1");

  await openMailbox(harness.db, "bill-new", profile("bill-new", "bill.new@cumuluscloud.app"));
  await assert.rejects(() => openBillingPortal(harness.db, stripe, { tenantId: "bill-new", returnUrl }), /Choose a plan first/);
});

test("subscription events set the plan, are idempotent, and never touch another mailbox", async () => {
  await openMailbox(harness.db, "bill-bea", profile("bill-bea", "bill.bea@cumuluscloud.app", "Bea"));
  await openMailbox(harness.db, "bill-cy", profile("bill-cy", "bill.cy@cumuluscloud.app", "Cy"));
  const db = harness.db;

  // Checkout finished: the customer and subscription bind to the mailbox that started it.
  const completed = event("evt_c1", "checkout.session.completed", {
    mode: "subscription",
    client_reference_id: "bill-bea",
    customer: "cus_bea",
    subscription: "sub_bea",
  });
  assert.equal(await handleStripeEvent(db, completed), "applied");
  assert.equal(await handleStripeEvent(db, completed), "duplicate");
  assert.equal((await row("bill-bea")).stripe_customer_id, "cus_bea");

  // Another tenant cannot claim Bea's customer by sending its own checkout for it.
  const hijack = event("evt_c2", "checkout.session.completed", {
    mode: "subscription",
    client_reference_id: "bill-bea",
    customer: "cus_mallory",
    subscription: "sub_mallory",
  });
  assert.equal(await handleStripeEvent(db, hijack), "ignored");
  assert.equal((await row("bill-bea")).stripe_customer_id, "cus_bea");

  const created = event("evt_s1", "customer.subscription.created", subscription("sub_bea", "cus_bea", "pro_monthly"));
  assert.equal(await handleStripeEvent(db, created), "applied");
  let bea = await row("bill-bea");
  assert.equal(bea.plan_id, "pro");
  assert.equal(bea.plan_status, "active");
  assert.equal(bea.stripe_subscription_id, "sub_bea");
  assert.equal(bea.plan_renews_at?.toISOString(), new Date(1_800_000_000 * 1000).toISOString());
  const snap = await readSnapshot(db, "bill-bea");
  assert.deepEqual(snap.me.limits, PLANS.pro);
  assert.equal(snap.me.plan, "Pro");
  assert.equal(snap.me.quotaGb, 50);
  assert.equal((await row("bill-cy")).plan_id, "plus");

  // Payment fails: past due keeps the plan's limits.
  assert.equal(await handleStripeEvent(db, event("evt_i1", "invoice.payment_failed", { customer: "cus_bea" })), "applied");
  assert.equal((await row("bill-bea")).plan_status, "past_due");
  assert.deepEqual(limitsFor("pro", "past_due"), PLANS.pro);

  // Card fixed and plan changed in the portal.
  const updated = event("evt_s2", "customer.subscription.updated", subscription("sub_bea", "cus_bea", "business_yearly"));
  assert.equal(await handleStripeEvent(db, updated), "applied");
  bea = await row("bill-bea");
  assert.equal(bea.plan_id, "business");
  assert.equal(bea.plan_status, "active");

  // An update for some other, stale subscription on the same customer is ignored.
  const stale = event("evt_s3", "customer.subscription.updated", subscription("sub_old", "cus_bea", "plus_monthly", "canceled"));
  assert.equal(await handleStripeEvent(db, stale), "ignored");
  assert.equal((await row("bill-bea")).plan_id, "business");

  // An unknown price keeps the stored plan rather than guessing.
  const odd = event("evt_s4", "customer.subscription.updated", subscription("sub_bea", "cus_bea", "legacy_price"));
  assert.equal(await handleStripeEvent(db, odd), "applied");
  assert.equal((await row("bill-bea")).plan_id, "business");

  // Canceled: limits drop to Free, the subscription is cleared, the customer is kept for the portal.
  const deleted = event("evt_s5", "customer.subscription.deleted", subscription("sub_bea", "cus_bea", "business_yearly", "canceled"));
  assert.equal(await handleStripeEvent(db, deleted), "applied");
  bea = await row("bill-bea");
  assert.equal(bea.plan_status, "canceled");
  assert.equal(bea.stripe_subscription_id, null);
  assert.equal(bea.stripe_customer_id, "cus_bea");
  assert.deepEqual((await readSnapshot(db, "bill-bea")).me.limits, PLANS.free);
  assert.equal((await readSnapshot(db, "bill-bea")).me.plan, "Free");

  // Resubscribing creates a new subscription, which replaces the canceled one.
  const again = event("evt_s6", "customer.subscription.created", subscription("sub_bea2", "cus_bea", "plus_monthly"));
  assert.equal(await handleStripeEvent(db, again), "applied");
  bea = await row("bill-bea");
  assert.equal(bea.plan_id, "plus");
  assert.equal(bea.plan_status, "active");
  assert.equal(bea.stripe_subscription_id, "sub_bea2");

  // Events for customers Mail does not know, and event types it does not handle, change nothing.
  assert.equal(
    await handleStripeEvent(db, event("evt_s7", "customer.subscription.updated", subscription("sub_x", "cus_unknown", "pro_monthly"))),
    "ignored",
  );
  assert.equal(await handleStripeEvent(db, event("evt_x", "charge.succeeded", { customer: "cus_bea" })), "ignored");
  assert.equal((await row("bill-cy")).plan_id, "plus");
  assert.equal((await row("bill-cy")).stripe_customer_id, null);
});

test("a subscription that arrives before checkout.session.completed binds through its metadata", async () => {
  await openMailbox(harness.db, "bill-dee", profile("bill-dee", "bill.dee@cumuluscloud.app", "Dee"));
  const early = event(
    "evt_e1",
    "customer.subscription.created",
    subscription("sub_dee", "cus_dee", "plus_yearly", "active", { metadata: { tenant_id: "bill-dee" } }),
  );
  assert.equal(await handleStripeEvent(harness.db, early), "applied");
  const dee = await row("bill-dee");
  assert.equal(dee.stripe_customer_id, "cus_dee");
  assert.equal(dee.plan_id, "plus");
  // Metadata cannot move a mailbox that already has a different customer.
  const moved = event(
    "evt_e2",
    "customer.subscription.created",
    subscription("sub_z", "cus_zed", "pro_monthly", "active", { metadata: { tenant_id: "bill-dee" } }),
  );
  assert.equal(await handleStripeEvent(harness.db, moved), "ignored");
  assert.equal((await row("bill-dee")).stripe_customer_id, "cus_dee");
});

test("a failure while applying releases the event id so Stripe's retry is processed", async () => {
  const failing = {
    query: async <T>(text: string, params: unknown[] = []) => {
      if (text.includes("update cumulus_mail.mailboxes")) throw new Error("database went away");
      return harness.db.query<T>(text, params);
    },
  };
  const retry = event("evt_r1", "invoice.payment_failed", { customer: "cus_bea" });
  await assert.rejects(() => handleStripeEvent(failing, retry), /went away/);
  const rows = await harness.db.query(`select id from cumulus_mail.billing_events where id = 'evt_r1'`);
  assert.equal(rows.length, 0);
});

test("with a Stripe client, out-of-order events apply Stripe's current state, not the stale payload", async () => {
  const db = harness.db;
  await openMailbox(db, "bill-eve", profile("bill-eve", "bill.eve@cumuluscloud.app", "Eve"));
  let current: Record<string, unknown> = subscription("sub_eve", "cus_eve", "pro_monthly", "active", {
    metadata: { tenant_id: "bill-eve" },
  });
  const fetched: string[] = [];
  const stripe: StripeClient = async (method, path) => {
    fetched.push(`${method} ${path}`);
    if (path === "/v1/subscriptions/sub_eve") return current;
    throw new Error(`unexpected ${path}`);
  };

  assert.equal(await handleStripeEvent(db, event("evt_o1", "customer.subscription.created", current), stripe), "applied");
  assert.equal((await row("bill-eve")).plan_id, "pro");

  // A late "past_due" update arrives after the card was fixed: Stripe now says active.
  const late = event("evt_o2", "customer.subscription.updated", subscription("sub_eve", "cus_eve", "plus_monthly", "past_due"));
  assert.equal(await handleStripeEvent(db, late, stripe), "applied");
  let eve = await row("bill-eve");
  assert.equal(eve.plan_status, "active");
  assert.equal(eve.plan_id, "pro");

  // A late payment failure for a subscription that is active again changes nothing.
  const failed = event("evt_o3", "invoice.payment_failed", {
    customer: "cus_eve",
    parent: { subscription_details: { subscription: "sub_eve" } },
  });
  assert.equal(await handleStripeEvent(db, failed, stripe), "ignored");
  assert.equal((await row("bill-eve")).plan_status, "active");

  // When Stripe says it is past due, the failure is applied.
  current = { ...current, status: "past_due" };
  assert.equal(await handleStripeEvent(db, event("evt_o4", "invoice.payment_failed", { customer: "cus_eve", subscription: "sub_eve" }), stripe), "applied");
  assert.equal((await row("bill-eve")).plan_status, "past_due");

  // An "updated" payload that still says active, for a subscription Stripe has since canceled, cancels.
  current = { ...current, status: "canceled" };
  assert.equal(await handleStripeEvent(db, event("evt_o5", "customer.subscription.updated", subscription("sub_eve", "cus_eve", "pro_monthly")), stripe), "applied");
  eve = await row("bill-eve");
  assert.equal(eve.plan_status, "canceled");
  assert.equal(eve.stripe_subscription_id, null);

  assert.ok(fetched.every((call) => call === "GET /v1/subscriptions/sub_eve"));

  // A subscription id that is not Stripe-shaped is never put into a request path.
  await handleStripeEvent(db, event("evt_o6", "customer.subscription.updated", subscription("../v1/customers", "cus_eve", "pro_monthly")), stripe);
  assert.equal(fetched.some((call) => call.includes("..")), false);
});

test("if Stripe cannot be reached the event is released so it is retried", async () => {
  const down: StripeClient = async () => {
    throw new Error("Stripe GET /v1/subscriptions/sub_eve failed: HTTP 503");
  };
  const retry = event("evt_o7", "customer.subscription.updated", subscription("sub_eve", "cus_eve", "pro_monthly"));
  await assert.rejects(() => handleStripeEvent(harness.db, retry, down), /503/);
  assert.equal((await harness.db.query(`select id from cumulus_mail.billing_events where id = 'evt_o7'`)).length, 0);
});
