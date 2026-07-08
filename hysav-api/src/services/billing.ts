// Billing logic — pure functions, Razorpay-flavored but SDK-free.
// Pricing model (INR, integer paise — Razorpay's unit):
//   ₹300/month flat for teams of up to 3
//   +₹100/month once the team is larger than 3
//   +₹50/month per person beyond 4
//   → 3 people ₹300 · 4 people ₹400 · 5 ₹450 · 6 ₹500 ...
// Every new workspace also gets a 3-day full-feature trial (Starter plan).
import { createHmac, timingSafeEqual } from "node:crypto";

export const PRICING = {
  BASE_PAISE: 300_00, //       ₹300 / month
  EXTRA_PAISE: 100_00, //      +₹100 / month above INCLUDED_MEMBERS
  INCLUDED_MEMBERS: 3,
  PER_PERSON_PAISE: 50_00, //  +₹50 / month per person beyond PER_PERSON_AFTER
  PER_PERSON_AFTER: 4,
  TRIAL_DAYS: 3,
  PERIOD_DAYS: 30,
  CURRENCY: "INR",
} as const;

export interface PlanQuote {
  memberCount: number;
  basePaise: number;
  extraPaise: number;
  perPersonPaise: number;
  amountPaise: number;
  currency: string;
  description: string;
}

export function quoteForMembers(memberCount: number): PlanQuote {
  const extra = memberCount > PRICING.INCLUDED_MEMBERS ? PRICING.EXTRA_PAISE : 0;
  const beyond = Math.max(0, memberCount - PRICING.PER_PERSON_AFTER);
  const perPerson = beyond * PRICING.PER_PERSON_PAISE;
  const amount = PRICING.BASE_PAISE + extra + perPerson;
  let description = `HySav Team — ₹300/month (up to ${PRICING.INCLUDED_MEMBERS} people)`;
  if (perPerson > 0) {
    description = `HySav Team Plus — ₹300 + ₹100 + ₹50×${beyond} (team of ${memberCount})`;
  } else if (extra > 0) {
    description = `HySav Team Plus — ₹300 base + ₹100 (team of ${memberCount})`;
  }
  return {
    memberCount,
    basePaise: PRICING.BASE_PAISE,
    extraPaise: extra,
    perPersonPaise: perPerson,
    amountPaise: amount,
    currency: PRICING.CURRENCY,
    description,
  };
}

/** Starter plan = 3-day full-feature trial, measured from workspace creation. */
export function trialEndsAt(workspaceCreatedAt: string): string {
  return new Date(new Date(workspaceCreatedAt).getTime() + PRICING.TRIAL_DAYS * 86_400_000).toISOString();
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Checkout-callback signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret).
 *  This is what Razorpay's checkout widget hands back to the success handler. */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC-SHA256 of the raw request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, webhookSecret: string): boolean {
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}
