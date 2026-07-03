// The UsageProvider contract. Everything that produces a usage number — a
// human typing it in, a CSV row, or a real provider API — resolves to the
// same UsageReading shape and lands in usage_snapshots the same way. The
// rest of the app (waste engine, dashboard, forecasts) never knows or cares
// where a number came from. Adding a provider = one new file implementing
// this interface + a registry entry in providers/index.ts.

export interface UsageReading {
  /** cumulative usage within the current billing period, in the tool's credit_unit */
  used: number;
  /** the cap it counts against; null if the provider doesn't expose one */
  limit: number | null;
  capturedAt: string; // ISO
}

export interface SyncContext {
  /** decrypted credential the workspace admin stored for this provider */
  apiKey: string;
  /** the tool row being synced (for limits, billing period bounds, etc.) */
  tool: {
    id: string;
    creditLimit: number | null;
    billingCycle: "monthly" | "annual";
    renewalDate: string;
  };
}

export interface UsageProvider {
  id: "manual" | "openai" | "anthropic" | "vercel";
  displayName: string;
  /** false ⇒ entry in the UI is manual-only; sync() must not be called */
  supportsLiveSync: boolean;
  /** honest one-liner shown in docs/UI about what this integration really does */
  integrationStatus: string;
  /** fetch a fresh reading from the provider's real API */
  sync?(ctx: SyncContext): Promise<UsageReading>;
}
