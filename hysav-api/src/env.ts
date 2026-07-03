// Central config. Everything comes from process.env (see .env.example);
// node --env-file=.env or the host's env can populate it. No secrets are
// hardcoded and APP_ENCRYPTION_KEY is validated up front so a misconfigured
// deploy fails at boot, not at first credential write.
import { randomBytes } from "node:crypto";

function readEnvFile(): void {
  // Minimal .env loader so `npm run dev` works without extra flags.
  // Ignores missing file; real deployments should set env vars directly.
  try {
    const fs = process.getBuiltinModule("node:fs");
    const text = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env file — fine */
  }
}
readEnvFile();

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/hysav.db",
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  emailFrom: process.env.EMAIL_FROM ?? "HySav <alerts@hysav.local>",
  resendApiKey: process.env.RESEND_API_KEY || null,
  seedOnBoot: (process.env.SEED_ON_BOOT ?? "1") === "1",
  // Razorpay (test keys work — rzp_test_...). Billing endpoints respond with
  // an honest 503 until these are set, so the code path is deploy-ready now
  // and activates the moment keys land in the environment.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || null,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  // In dev/test an ephemeral key is generated (encrypted credentials won't
  // survive a restart — acceptable for local use, loud comment for reviewers).
  encryptionKey: (() => {
    const hex = process.env.APP_ENCRYPTION_KEY;
    if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    if (hex) throw new Error("APP_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY is required in production");
    }
    if (!isTest) {
      console.warn(
        "[env] APP_ENCRYPTION_KEY not set — using an ephemeral key. " +
          "Stored integration credentials will not survive a restart.",
      );
    }
    return randomBytes(32);
  })(),
};
