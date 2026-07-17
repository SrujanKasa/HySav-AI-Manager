// Provider registry. Manual entry is itself a provider so the rest of the
// app treats "a human typed a number" and "we called OpenAI's API"
// identically — both end up as usage_snapshots rows.
import type { UsageProvider } from "./types.ts";
import { openaiProvider } from "./openai.ts";
import { anthropicProvider } from "./anthropic.ts";
import { elevenlabsProvider } from "./elevenlabs.ts";
import { openrouterProvider } from "./openrouter.ts";
import { vercelProvider } from "./vercel.ts";

export const manualProvider: UsageProvider = {
  id: "manual",
  displayName: "Manual entry",
  supportsLiveSync: false,
  integrationStatus: "Default path — usage reported by hand or CSV import.",
};

export const providers: Record<string, UsageProvider> = {
  manual: manualProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  elevenlabs: elevenlabsProvider,
  openrouter: openrouterProvider,
  vercel: vercelProvider,
};

export type { UsageProvider, UsageReading, SyncContext } from "./types.ts";
