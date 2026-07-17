// Auto-sync — the machinery that makes connected tools update themselves.
// One code path serves four triggers:
//   1. the dashboard's "Sync now" button (routes/integrations.ts)
//   2. opportunistic refresh when the dashboard loads and data is stale
//   3. the local server's hourly background job (src/index.ts)
//   4. Vercel Cron's daily hit on /api/v1/jobs/daily (production)
// Tools whose provider has no real usage API stay manual — that's honesty,
// not laziness; see providers/*.ts for what's live vs stubbed.
import { decryptSecret } from "../crypto.ts";
import { all, insert, now, one, update, uuid } from "../db.ts";
import { providers } from "../providers/index.ts";
import type { ToolRow } from "./toolData.ts";

export interface SyncResult {
  toolId: string;
  name: string;
  ok: boolean;
  used?: number;
  error?: string;
}

/** Sync every tool in a workspace whose usage_source matches the provider.
 *  Returns per-tool results; throws only on missing credential/provider. */
export async function syncProvider(workspaceId: string, providerId: string): Promise<SyncResult[]> {
  const p = providers[providerId];
  if (!p || !p.supportsLiveSync || !p.sync) {
    throw new Error(`${p ? p.displayName : providerId}: live sync not available`);
  }
  const cred = await one<{ key_ciphertext: string }>("integration_credentials", {
    workspace_id: workspaceId,
    provider: providerId,
  });
  if (!cred) throw new Error(`No ${p.displayName} credential connected for this workspace`);

  const tools = await all<ToolRow>("tools", {
    workspace_id: workspaceId,
    usage_source: providerId,
    status: { $ne: "cancelled" },
  });

  const apiKey = decryptSecret(cred.key_ciphertext);
  const results: SyncResult[] = [];
  for (const tool of tools) {
    try {
      const reading = await p.sync({
        apiKey,
        tool: {
          id: tool.id,
          creditLimit: tool.credit_limit,
          billingCycle: tool.billing_cycle,
          renewalDate: tool.renewal_date,
        },
      });
      await insert("usage_snapshots", {
        id: uuid(),
        tool_id: tool.id,
        captured_at: reading.capturedAt,
        used_amount: reading.used,
        limit_amount: reading.limit,
        source: providerId,
      });
      await update("tools", { id: tool.id }, { last_usage_update_at: reading.capturedAt, updated_at: now() });
      results.push({ toolId: tool.id, name: tool.name, ok: true, used: reading.used });
    } catch (err) {
      // per-tool errors surface without aborting the batch; never echoes the key
      results.push({ toolId: tool.id, name: tool.name, ok: false, error: (err as Error).message });
    }
  }
  await update(
    "integration_credentials",
    { workspace_id: workspaceId, provider: providerId },
    { last_synced_at: now() },
  );
  return results;
}

/** Opportunistic refresh: sync any of the workspace's connected providers
 *  whose last sync is older than maxAgeHours. Cheap no-op when fresh. */
export async function syncWorkspaceIfStale(workspaceId: string, maxAgeHours: number): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const creds = await all<{ provider: string; last_synced_at: string | null }>("integration_credentials", {
    workspace_id: workspaceId,
  });
  for (const c of creds) {
    if (c.last_synced_at && c.last_synced_at > cutoff) continue;
    if (!providers[c.provider]?.supportsLiveSync) continue;
    try {
      await syncProvider(workspaceId, c.provider);
    } catch (err) {
      console.error(`[sync] auto-sync ${c.provider} failed for workspace ${workspaceId}:`, (err as Error).message);
    }
  }
}

/** Cron/background sweep: every connected credential in every workspace. */
export async function syncEverything(): Promise<{ workspaces: number; synced: number; failed: number }> {
  const creds = await all<{ workspace_id: string; provider: string }>("integration_credentials", {});
  const seen = new Set<string>();
  let synced = 0;
  let failed = 0;
  for (const c of creds) {
    if (!providers[c.provider]?.supportsLiveSync) continue;
    seen.add(c.workspace_id);
    try {
      const results = await syncProvider(c.workspace_id, c.provider);
      synced += results.filter((r) => r.ok).length;
      failed += results.filter((r) => !r.ok).length;
    } catch (err) {
      failed++;
      console.error(`[sync] sweep ${c.provider}/${c.workspace_id}:`, (err as Error).message);
    }
  }
  return { workspaces: seen.size, synced, failed };
}
