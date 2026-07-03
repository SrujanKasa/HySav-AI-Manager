// Vercel usage integration — STUBBED, deliberately.
// Vercel does have real, documented usage endpoints (e.g. the REST API's
// usage/billing resources), so this is *realistic* to build — but it is not
// wired up yet because we have no test account to verify response shapes
// against, and shipping an unverified parser would be worse than being
// honest. supportsLiveSync=false keeps it manual-entry in the meantime;
// flipping it on later only requires implementing sync() here.
import type { UsageProvider } from "./types.ts";

export const vercelProvider: UsageProvider = {
  id: "vercel",
  displayName: "Vercel",
  supportsLiveSync: false,
  integrationStatus:
    "Stubbed — official usage API exists and is planned; entry is manual until the sync is implemented and verified.",
};
