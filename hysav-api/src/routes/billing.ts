// Razorpay billing endpoints — deploy-ready, activate by setting test keys
// (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET).
//
// Flow (standard Razorpay Orders + Checkout):
//   1. GET  /workspaces/:id/billing          → quote + trial/paid status
//   2. POST /workspaces/:id/billing/create-subscription → recurring flow the
//      pricing page uses (plan + subscription created server-side)
//   3. POST /workspaces/:id/billing/verify-subscription → HMAC check → active
//   Also: one-time order flow (order / verify) and the server-to-server
//   webhook. Key secrets never leave the server; only the publishable key
//   id does.
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { all, insert, now, one, update, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, parseBody, rateLimit, requireAuth, requireMembership } from "../middleware.ts";
import {
  PRICING,
  quoteForMembers,
  trialEndsAt,
  verifyCheckoutSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
} from "../services/billing.ts";

export const billingRouter = Router();
export const webhookRouter = Router();

// raw request bodies for webhook HMAC verification; populated by the
// express.json `verify` hook in app.ts
export const rawBodies = new WeakMap<Request, Buffer>();

async function memberCount(workspaceId: string): Promise<number> {
  return (await all("memberships", { workspace_id: workspaceId })).length;
}

async function paidUntil(workspaceId: string): Promise<string | null> {
  const rows = await all<{ period_end: string }>(
    "payments",
    { workspace_id: workspaceId, status: "paid" },
    { sort: { period_end: -1 }, limit: 1 },
  );
  return rows[0]?.period_end ?? null;
}

async function markPaid(paymentRow: { id: string }, razorpayPaymentId: string): Promise<void> {
  const start = now();
  const end = new Date(Date.now() + PRICING.PERIOD_DAYS * 86_400_000).toISOString();
  await update(
    "payments",
    { id: paymentRow.id, status: { $ne: "paid" } },
    { status: "paid", razorpay_payment_id: razorpayPaymentId, period_start: start, period_end: end, updated_at: now() },
  );
}

billingRouter.use(requireAuth);

billingRouter.get("/workspaces/:id/billing", async (req, res) => {
  await requireMembership(req, req.params.id);
  const ws = await one<{ created_at: string }>("workspaces", { id: req.params.id });
  const quote = quoteForMembers(await memberCount(req.params.id));
  const until = await paidUntil(req.params.id);
  // Starter plan: every workspace gets a 3-day full-feature trial from creation
  const trialUntil = trialEndsAt(ws!.created_at);
  const trialActive = trialUntil > now();
  const paidActive = !!until && until > now();
  res.json({
    quote,
    configured: !!(env.razorpayKeyId && env.razorpayKeySecret),
    paidUntil: until,
    trial: { endsAt: trialUntil, active: trialActive, days: PRICING.TRIAL_DAYS },
    active: paidActive || trialActive,
  });
});

function razorpayHeaders(): { Authorization: string; "Content-Type": string } {
  const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64");
  return { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
}

function requireRazorpay(): void {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new HttpError(
      503,
      "Razorpay is not configured yet — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys work) and retry",
    );
  }
}

/* ---------- one-time order flow ---------- */

billingRouter.post("/workspaces/:id/billing/order", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  requireRazorpay();
  const quote = quoteForMembers(await memberCount(req.params.id));
  const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: razorpayHeaders(),
    body: JSON.stringify({
      amount: quote.amountPaise,
      currency: quote.currency,
      receipt: `ws-${req.params.id.slice(0, 34)}`,
      notes: { workspaceId: req.params.id, plan: quote.description },
    }),
  });
  if (!rzpRes.ok) {
    // Razorpay error bodies are safe to relay in status form only — never log auth
    throw new HttpError(502, `Razorpay order creation failed (${rzpRes.status})`);
  }
  const order = (await rzpRes.json()) as { id: string; amount: number; currency: string };
  await insert("payments", {
    id: uuid(),
    workspace_id: req.params.id,
    razorpay_order_id: order.id,
    amount_paise: order.amount,
    currency: order.currency,
    status: "created",
    created_at: now(),
    updated_at: now(),
  });
  res.status(201).json({
    orderId: order.id,
    amountPaise: order.amount,
    currency: order.currency,
    keyId: env.razorpayKeyId, // publishable — the checkout widget needs it
    description: quote.description,
  });
});

/** Recurring flow — what the pricing page's Checkout uses. Creates a
 *  Razorpay Plan for the workspace's current quote, then a Subscription on
 *  it (12 monthly cycles). Only the subscription id + publishable key id go
 *  back to the client; amounts always come from the server-side quote. */
billingRouter.post("/workspaces/:id/billing/create-subscription", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  requireRazorpay();
  const quote = quoteForMembers(await memberCount(req.params.id));

  // Razorpay has no lookup-plan-by-amount API, so create a plan per
  // subscription; in test mode that's harmless and keeps this stateless.
  const planRes = await fetch("https://api.razorpay.com/v1/plans", {
    method: "POST",
    headers: razorpayHeaders(),
    body: JSON.stringify({
      period: "monthly",
      interval: 1,
      item: { name: quote.description, amount: quote.amountPaise, currency: quote.currency },
    }),
  });
  if (!planRes.ok) throw new HttpError(502, `Razorpay plan creation failed (${planRes.status})`);
  const plan = (await planRes.json()) as { id: string };

  const subRes = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: razorpayHeaders(),
    body: JSON.stringify({
      plan_id: plan.id,
      total_count: 12,
      quantity: 1,
      customer_notify: 1,
      notes: { workspaceId: req.params.id, plan: quote.description },
    }),
  });
  if (!subRes.ok) throw new HttpError(502, `Razorpay subscription creation failed (${subRes.status})`);
  const sub = (await subRes.json()) as { id: string };

  await insert("payments", {
    id: uuid(),
    workspace_id: req.params.id,
    razorpay_subscription_id: sub.id,
    amount_paise: quote.amountPaise,
    currency: quote.currency,
    status: "created",
    created_at: now(),
    updated_at: now(),
  });
  res.status(201).json({
    subscriptionId: sub.id,
    amountPaise: quote.amountPaise,
    currency: quote.currency,
    keyId: env.razorpayKeyId, // publishable — the checkout widget needs it
    description: quote.description,
  });
});

const verifySubSchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpaySubscriptionId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

billingRouter.post("/workspaces/:id/billing/verify-subscription", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  if (!env.razorpayKeySecret) throw new HttpError(503, "Razorpay is not configured yet");
  const body = parseBody(verifySubSchema, req.body);
  const payment = await one<{ id: string; workspace_id: string }>("payments", {
    razorpay_subscription_id: body.razorpaySubscriptionId,
  });
  if (!payment || payment.workspace_id !== req.params.id) throw new HttpError(404, "Unknown subscription");
  if (
    !verifySubscriptionSignature(
      body.razorpayPaymentId,
      body.razorpaySubscriptionId,
      body.razorpaySignature,
      env.razorpayKeySecret,
    )
  ) {
    throw new HttpError(400, "Signature verification failed");
  }
  await markPaid(payment, body.razorpayPaymentId);
  res.json({ active: true, paidUntil: await paidUntil(req.params.id) });
});

const verifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

billingRouter.post("/workspaces/:id/billing/verify", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  if (!env.razorpayKeySecret) throw new HttpError(503, "Razorpay is not configured yet");
  const body = parseBody(verifySchema, req.body);
  const payment = await one<{ id: string; workspace_id: string }>("payments", {
    razorpay_order_id: body.razorpayOrderId,
  });
  if (!payment || payment.workspace_id !== req.params.id) throw new HttpError(404, "Unknown order");
  if (!verifyCheckoutSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature, env.razorpayKeySecret)) {
    throw new HttpError(400, "Signature verification failed");
  }
  await markPaid(payment, body.razorpayPaymentId);
  res.json({ active: true, paidUntil: await paidUntil(req.params.id) });
});

// Server-to-server webhook (configure the URL + secret in the Razorpay
// dashboard). Unauthenticated by design; the HMAC is the credential.
webhookRouter.post("/billing/webhook", rateLimit(60, 60_000), async (req, res) => {
  if (!env.razorpayWebhookSecret) throw new HttpError(503, "Webhook secret not configured");
  const raw = rawBodies.get(req);
  const signature = req.headers["x-razorpay-signature"];
  if (!raw || typeof signature !== "string" || !verifyWebhookSignature(raw, signature, env.razorpayWebhookSecret)) {
    throw new HttpError(400, "Invalid webhook signature");
  }
  const event = req.body as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string } };
      subscription?: { entity?: { id?: string } };
    };
  };
  if (event.event === "payment.captured" || event.event === "order.paid") {
    const entity = event.payload?.payment?.entity;
    if (entity?.order_id && entity.id) {
      const payment = await one<{ id: string }>("payments", { razorpay_order_id: entity.order_id });
      if (payment) await markPaid(payment, entity.id);
    }
  }
  // recurring renewals: extend the paid period each time the subscription charges
  if (event.event === "subscription.charged") {
    const subId = event.payload?.subscription?.entity?.id;
    const payId = event.payload?.payment?.entity?.id;
    if (subId && payId) {
      const payment = await one<{ id: string }>("payments", { razorpay_subscription_id: subId });
      if (payment) {
        // reset status so markPaid's status guard lets a renewal through
        await update("payments", { id: payment.id }, { status: "created", updated_at: now() });
        await markPaid(payment, payId);
      }
    }
  }
  // Always 200 for recognized-but-unhandled events so Razorpay doesn't retry forever.
  res.json({ received: true });
});
