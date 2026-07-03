import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  quoteForMembers,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../src/services/billing.ts";

describe("quoteForMembers — ₹300 base, +₹100 above 3 people", () => {
  it("charges the flat base for teams of up to 3", () => {
    for (const n of [1, 2, 3]) {
      const q = quoteForMembers(n);
      expect(q.amountPaise).toBe(30_000);
      expect(q.extraPaise).toBe(0);
      expect(q.currency).toBe("INR");
    }
  });

  it("adds ₹100 once the team crosses 3", () => {
    for (const n of [4, 7, 30]) {
      const q = quoteForMembers(n);
      expect(q.amountPaise).toBe(40_000);
      expect(q.basePaise).toBe(30_000);
      expect(q.extraPaise).toBe(10_000);
    }
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

  it("verifies webhook bodies byte-for-byte", () => {
    const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from("{}"), sig, secret)).toBe(false);
  });
});
