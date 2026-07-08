import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  quoteForMembers,
  trialEndsAt,
  verifyCheckoutSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
} from "../src/services/billing.ts";

describe("quoteForMembers — ₹300 base, +₹100 above 3, +₹50/person beyond 4", () => {
  it("charges the flat base for teams of up to 3", () => {
    for (const n of [1, 2, 3]) {
      const q = quoteForMembers(n);
      expect(q.amountPaise).toBe(30_000);
      expect(q.extraPaise).toBe(0);
      expect(q.perPersonPaise).toBe(0);
      expect(q.currency).toBe("INR");
    }
  });

  it("adds ₹100 for the 4th person (₹400 total)", () => {
    const q = quoteForMembers(4);
    expect(q.basePaise).toBe(30_000);
    expect(q.extraPaise).toBe(10_000);
    expect(q.perPersonPaise).toBe(0);
    expect(q.amountPaise).toBe(40_000);
  });

  it("adds ₹50 per person beyond 4", () => {
    expect(quoteForMembers(5).amountPaise).toBe(45_000); //  400 + 50
    expect(quoteForMembers(6).amountPaise).toBe(50_000); //  400 + 100
    expect(quoteForMembers(8).amountPaise).toBe(60_000); //  400 + 200
    const q = quoteForMembers(10);
    expect(q.perPersonPaise).toBe(30_000); //                6 × ₹50
    expect(q.amountPaise).toBe(70_000);
    expect(q.description).toContain("₹50×6");
  });
});

describe("trialEndsAt — Starter plan 3-day trial", () => {
  it("ends exactly 3 days after workspace creation", () => {
    expect(trialEndsAt("2026-07-01T00:00:00.000Z")).toBe("2026-07-04T00:00:00.000Z");
  });
});

describe("Razorpay signature verification", () => {
  const secret = "test_secret_abc";

  it("accepts a correctly signed checkout callback", () => {
    const sig = createHmac("sha256", secret).update("order_123|pay_456").digest("hex");
    expect(verifyCheckoutSignature("order_123", "pay_456", sig, secret)).toBe(true);
  });

  it("rejects a tampered payment id", () => {
    const sig = createHmac("sha256", secret).update("order_123|pay_456").digest("hex");
    expect(verifyCheckoutSignature("order_123", "pay_EVIL", sig, secret)).toBe(false);
  });

  it("rejects garbage signatures without throwing", () => {
    expect(verifyCheckoutSignature("order_123", "pay_456", "not-hex-at-all", secret)).toBe(false);
    expect(verifyCheckoutSignature("order_123", "pay_456", "", secret)).toBe(false);
  });

  it("verifies subscription signatures (payment_id|subscription_id order)", () => {
    const sig = createHmac("sha256", secret).update("pay_456|sub_789").digest("hex");
    expect(verifySubscriptionSignature("pay_456", "sub_789", sig, secret)).toBe(true);
    // operand order matters — the orders-flow ordering must NOT validate
    const wrongOrder = createHmac("sha256", secret).update("sub_789|pay_456").digest("hex");
    expect(verifySubscriptionSignature("pay_456", "sub_789", wrongOrder, secret)).toBe(false);
  });

  it("verifies webhook bodies byte-for-byte", () => {
    const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from("{}"), sig, secret)).toBe(false);
  });
});
