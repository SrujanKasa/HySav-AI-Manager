// OpenRouter usage integration — REAL, documented public API.
// GET https://openrouter.ai/api/v1/credits (Bearer key) returns lifetime
// total_credits purchased and total_usage spent. Lifetime rather than
// per-period, but the waste engine's snapshot deltas handle windows, so the
// trend math still works.
import type { SyncContext, UsageProvider, UsageReading } from "./types.ts";

export const openrouterProvider: UsageProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  supportsLiveSync: true,
  integrationStatus: "Live — official credits API reports usage vs purchased credits (regular API key).",

  async sync(ctx: SyncContext): Promise<UsageReading> {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenRouter credits API returned ${res.status}`);
    const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
    return {
      used: Math.round((body.data?.total_usage ?? 0) * 100) / 100,
      limit: body.data?.total_credits ?? ctx.tool.creditLimit,
      capturedAt: new Date().toISOString(),
    };
  },
};
