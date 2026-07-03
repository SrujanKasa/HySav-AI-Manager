// OpenAI usage integration — REAL, documented API.
// Uses the org Costs endpoint (https://platform.openai.com/docs/api-reference/usage/costs):
//   GET https://api.openai.com/v1/organization/costs?start_time=...&limit=...
// Requires an *Admin* API key (sk-admin-...), created in the org settings.
// We report period-to-date spend in dollars; if the tool row has a
// credit_limit set (e.g. a monthly budget), the dashboard turns that into %.
import type { SyncContext, UsageProvider, UsageReading } from "./types.ts";

function periodStartUnix(ctx: SyncContext): number {
  const renewal = new Date(ctx.tool.renewalDate);
  const start = new Date(renewal);
  if (ctx.tool.billingCycle === "annual") start.setFullYear(start.getFullYear() - 1);
  else start.setMonth(start.getMonth() - 1);
  return Math.floor(start.getTime() / 1000);
}

export const openaiProvider: UsageProvider = {
  id: "openai",
  displayName: "OpenAI",
  supportsLiveSync: true,
  integrationStatus: "Live — official org Costs API (requires an OpenAI Admin key).",

  async sync(ctx: SyncContext): Promise<UsageReading> {
    let total = 0;
    let page: string | null = null;
    // paginate the daily cost buckets for the current billing period
    for (let i = 0; i < 12; i++) {
      const url = new URL("https://api.openai.com/v1/organization/costs");
      url.searchParams.set("start_time", String(periodStartUnix(ctx)));
      url.searchParams.set("limit", "31");
      if (page) url.searchParams.set("page", page);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
      });
      if (!res.ok) {
        // Never echo the key; surface the provider's status only.
        throw new Error(`OpenAI costs API returned ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: { results?: { amount?: { value?: number } }[] }[];
        has_more?: boolean;
        next_page?: string;
      };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) total += r.amount?.value ?? 0;
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return { used: Math.round(total * 100) / 100, limit: ctx.tool.creditLimit, capturedAt: new Date().toISOString() };
  },
};
