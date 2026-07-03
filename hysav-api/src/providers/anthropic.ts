// Anthropic usage integration — REAL, documented Admin API.
// Uses the organization Cost Report endpoint
// (https://docs.anthropic.com/en/api/admin-api — Usage & Cost):
//   GET https://api.anthropic.com/v1/organizations/cost_report
// Requires an Admin API key (sk-ant-admin-...) from the Anthropic Console.
// Reports period-to-date spend in USD against the tool's configured budget.
import type { SyncContext, UsageProvider, UsageReading } from "./types.ts";

function periodStartIso(ctx: SyncContext): string {
  const renewal = new Date(ctx.tool.renewalDate);
  const start = new Date(renewal);
  if (ctx.tool.billingCycle === "annual") start.setFullYear(start.getFullYear() - 1);
  else start.setMonth(start.getMonth() - 1);
  return start.toISOString();
}

export const anthropicProvider: UsageProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  supportsLiveSync: true,
  integrationStatus: "Live — official Admin API cost report (requires an Anthropic Admin key).",

  async sync(ctx: SyncContext): Promise<UsageReading> {
    let total = 0;
    let page: string | null = null;
    for (let i = 0; i < 12; i++) {
      const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
      url.searchParams.set("starting_at", periodStartIso(ctx));
      url.searchParams.set("limit", "31");
      if (page) url.searchParams.set("page", page);

      const res = await fetch(url, {
        headers: {
          "x-api-key": ctx.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!res.ok) throw new Error(`Anthropic cost report API returned ${res.status}`);
      const body = (await res.json()) as {
        data?: { results?: { amount?: string | number }[] }[];
        has_more?: boolean;
        next_page?: string;
      };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) total += Number(r.amount ?? 0);
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return { used: Math.round(total * 100) / 100, limit: ctx.tool.creditLimit, capturedAt: new Date().toISOString() };
  },
};
