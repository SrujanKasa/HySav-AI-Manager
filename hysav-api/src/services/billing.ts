// Billing logic — pure functions, Razorpay-flavored but SDK-free.
// Pricing model: ₹300/month flat, +₹100/month once the team has more than 3
// members. Amounts are integer paise (Razorpay's unit for INR).
import { createHmac, timingSafeEqual } from "node:crypto";

export const PRICING = {
  BASE_PAISE: 300_00, //     ₹300 / month
  EXTRA_PAISE: 100_00, //    +₹100 / month
  INCLUDED_MEMBERS: 3, //    the +₹100 kicks in above this
  PERIOD_DAYS: 30,
  CURRENCY: "INR",
} as const;

export interface PlanQuote {
  memberCount: number;
  basePaise: number;
  extraPaise: number;
  amountPaise: number;
  currency: string;
  description: string;
}

export function quoteForMembers(memberCount: number): PlanQuote {
  const extra = memberCount > PRICING.INCLUDED_MEMBERS ? PRICING.EXTRA_PAISE : 0;
  return {
    memberCount,
    basePaise: PRICING.BASE_PAISE,
    extraPaise: extra,
    amountPaise: PRICING.BASE_PAISE + extra,
    currency: PRICING.CURRENCY,
    description:
      extra > 0
        ? `HySav Team Plus — ₹300 base + ₹100 (team of ${memberCount})`
        : `HySav Team — ₹300/month (up to ${PRICING.INCLUDED_MEMBERS} people)`,
  };
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
