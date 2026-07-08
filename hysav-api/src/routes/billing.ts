// Razorpay billing endpoints — deploy-ready, activate by setting test keys
// (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET).
//
// Flow (standard Razorpay Orders + Checkout):
//   1. GET  /workspaces/:id/billing          → quote + paid-until status
//   2. POST /workspaces/:id/billing/order    → create a Razorpay order; the
//      frontend opens Checkout with the returned orderId + keyId (publishable)
//   3a. POST /workspaces/:id/billing/verify  → checkout success handler posts
//       order/payment ids + signature; we verify the HMAC and mark paid
//   3b. POST /billing/webhook                → server-to-server confirmation
//       (payment.captured / order.paid), verified against the webhook secret
// Key secrets never leave the server; only the publishable key id does.
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { all, now, one, run, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, parseBody, rateLimit, requireAuth, requireMembership } from "../middleware.ts";
import {
  PRICING,
  quoteForMembers,
  trialEndsAt,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../services/billing.ts";

export const billingRouter = Router();
export const webhookRouter = Router();

// raw request bodies for webhook HMAC verification; populated by the
// express.json `verify` hook in index.ts
export const rawBodies = new WeakMap<Request, Buffer>();

function memberCount(workspaceId: string): number {
  return all("SELECT user_id FROM memberships WHERE workspace_id = ?", workspaceId).length;
}

function paidUntil(workspaceId: string): string | null {
  const row = one<{ period_end: string }>(
    "SELECT period_end FROM payments WHERE workspace_id = ? AND status = 'paid' ORDER BY period_end DESC LIMIT 1",
    workspaceId,
  );
  return row?.period_end ?? null;
}

function markPaid(paymentRow: { id: string }, razorpayPaymentId: string): void {
  const start = now();
  const end = new Date(Date.now() + PRICING.PERIOD_DAYS * 86_400_000).toISOString();
  run(
    `UPDATE payments SET status = 'paid', razorpay_payment_id = ?, period_start = ?, period_end = ?, updated_at = ?
     WHERE id = ? AND status != 'paid'`,
    razorpayPaymentId,
    start,
    end,
    now(),
    paymentRow.id,
  );
}

billingRouter.use(requireAuth);

billingRouter.get("/workspaces/:id/billing", (req, res) => {
  requireMembership(req, req.params.id);
  const ws = one<{ created_at: string }>("SELECT created_at FROM workspaces WHERE id = ?", req.params.id);
  const quote = quoteForMembers(memberCount(req.params.id));
  const until = paidUntil(req.params.id);
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

billingRouter.post("/workspaces/:id/billing/order", async (req, res) => {
  requireMembership(req, req.params.id, true);
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new HttpError(
      503,
      "Razorpay is not configured yet — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys work) and retry",
    );
  }
  const quote = quoteForMembers(memberCount(req.params.id));
  const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64");
  const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
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
  run(
    `INSERT INTO payments (id, workspace_id, razorpay_order_id, amount_paise, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
    uuid(),
    req.params.id,
    order.id,
    order.amount,
    order.currency,
    now(),
    now(),
  );
  res.status(201).json({
    orderId: order.id,
    amountPaise: order.amount,
    currency: order.currency,
    keyId: env.razorpayKeyId, // publishable — the checkout widget needs it
    description: quote.description,
  });
});

const verifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

billingRouter.post("/workspaces/:id/billing/verify", (req, res) => {
  requireMembership(req, req.params.id, true);
  if (!env.razorpayKeySecret) throw new HttpError(503, "Razorpay is not configured yet");
  const body = parseBody(verifySchema, req.body);
  const payment = one<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM payments WHERE razorpay_order_id = ?",
    body.razorpayOrderId,
  );
  if (!payment || payment.workspace_id !== req.params.id) throw new HttpError(404, "Unknown order");
  if (!verifyCheckoutSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature, env.razorpayKeySecret)) {
    throw new HttpError(400, "Signature verification failed");
  }
  markPaid(payment, body.razorpayPaymentId);
  res.json({ active: true, paidUntil: paidUntil(req.params.id) });
});

// Server-to-server webhook (configure the URL + secret in the Razorpay
// dashboard). Unauthenticated by design; the HMAC is the credential.
webhookRouter.post("/billing/webhook", rateLimit(60, 60_000), (req, res) => {
  if (!env.razorpayWebhookSecret) throw new HttpError(503, "Webhook secret not configured");
  const raw = rawBodies.get(req);
  const signature = req.headers["x-razorpay-signature"];
  if (!raw || typeof signature !== "string" || !verifyWebhookSignature(raw, signature, env.razorpayWebhookSecret)) {
    throw new HttpError(400, "Invalid webhook signature");
  }
  const event = req.body as {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
  };
  if (event.event === "payment.captured" || event.event === "order.paid") {
    const entity = event.payload?.payment?.entity;
    if (entity?.order_id && entity.id) {
      const payment = one<{ id: string }>("SELECT id FROM payments WHERE razorpay_order_id = ?", entity.order_id);
      if (payment) markPaid(payment, entity.id);
    }
  }
  // Always 200 for recognized-but-unhandled events so Razorpay doesn't retry forever.
  res.json({ received: true });
});
