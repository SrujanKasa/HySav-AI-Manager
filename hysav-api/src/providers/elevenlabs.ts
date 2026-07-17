// ElevenLabs usage integration — REAL, documented public API.
// GET https://api.elevenlabs.io/v1/user/subscription (xi-api-key header)
// returns character_count / character_limit for the current billing cycle —
// exactly the used/limit pair the waste engine wants, and it works with a
// normal API key (no special admin tier).
import type { SyncContext, UsageProvider, UsageReading } from "./types.ts";

export const elevenlabsProvider: UsageProvider = {
  id: "elevenlabs",
  displayName: "ElevenLabs",
  supportsLiveSync: true,
  integrationStatus: "Live — official subscription API reports character usage + limit (regular API key).",

  async sync(ctx: SyncContext): Promise<UsageReading> {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": ctx.apiKey },
    });
    if (!res.ok) throw new Error(`ElevenLabs subscription API returned ${res.status}`);
    const body = (await res.json()) as { character_count?: number; character_limit?: number };
    return {
      used: body.character_count ?? 0,
      // the provider knows its own cap — prefer it over whatever was typed in
      limit: body.character_limit ?? ctx.tool.creditLimit,
      capturedAt: new Date().toISOString(),
    };
  },
};
