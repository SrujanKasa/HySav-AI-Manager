// Live-integration credentials + sync. Keys are AES-256-GCM encrypted at
// rest, only the last 4 chars are ever returned, and plaintext keys are
// never logged (see also errorHandler, which never echoes internals).
import { Router } from "express";
import { z } from "zod";
import { encryptSecret } from "../crypto.ts";
import { all, now, one, remove, update, uuid } from "../db.ts";
import { HttpError, currentUser, parseBody, requireAuth, requireMembership } from "../middleware.ts";
import { assertPlanWritable } from "../services/plan.ts";
import { syncProvider } from "../services/sync.ts";
import { providers } from "../providers/index.ts";
import type { ToolRow } from "../services/toolData.ts";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

integrationsRouter.get("/workspaces/:id/integrations", async (req, res) => {
  await requireMembership(req, req.params.id);
  const rows = await all<{ id: string; provider: string; key_last4: string; created_at: string; last_synced_at: string | null }>(
    "integration_credentials",
    { workspace_id: req.params.id },
  );
  res.json({
    // what's connectable and what's honestly just a stub
    providers: Object.values(providers).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      supportsLiveSync: p.supportsLiveSync,
      integrationStatus: p.integrationStatus,
    })),
    connected: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      keyLast4: r.key_last4, // never the key itself
      createdAt: r.created_at,
      lastSyncedAt: r.last_synced_at,
    })),
  });
});

const connectSchema = z.object({
  provider: z.enum(["openai", "anthropic", "elevenlabs", "openrouter", "vercel"]),
  apiKey: z.string().min(8).max(500),
});

integrationsRouter.post("/workspaces/:id/integrations", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await assertPlanWritable(req.params.id);
  const user = currentUser(req);
  const body = parseBody(connectSchema, req.body);
  const p = providers[body.provider];
  if (!p.supportsLiveSync) {
    throw new HttpError(400, `${p.displayName}: ${p.integrationStatus}`);
  }
  await update(
    "integration_credentials",
    { workspace_id: req.params.id, provider: body.provider },
    {
      id: uuid(),
      workspace_id: req.params.id,
      provider: body.provider,
      key_ciphertext: encryptSecret(body.apiKey),
      key_last4: body.apiKey.slice(-4),
      created_by: user.id,
      created_at: now(),
      last_synced_at: null,
    },
    true, // upsert — reconnecting replaces the stored key
  );
  res.status(201).json({ provider: body.provider, keyLast4: body.apiKey.slice(-4) });
});

integrationsRouter.delete("/workspaces/:id/integrations/:provider", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await remove("integration_credentials", { workspace_id: req.params.id, provider: req.params.provider });
  res.status(204).end();
});

/** Pull fresh usage from the provider API for every tool in the workspace
 *  whose usage_source matches. The reading lands in usage_snapshots exactly
 *  like a manual entry would — same collection, same downstream logic.
 *  (Auto-sync also runs this without anyone clicking — see services/sync.ts.) */
integrationsRouter.post("/workspaces/:id/integrations/:provider/sync", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await assertPlanWritable(req.params.id);
  const providerId = req.params.provider;
  const p = providers[providerId];
  if (!p) throw new HttpError(404, "Unknown provider");
  if (!p.supportsLiveSync) throw new HttpError(400, `${p.displayName}: ${p.integrationStatus}`);
  const hasTools = await one<ToolRow>("tools", {
    workspace_id: req.params.id,
    usage_source: providerId,
    status: { $ne: "cancelled" },
  });
  if (!hasTools) {
    throw new HttpError(400, `No tools in this workspace have usage_source='${providerId}'`);
  }
  try {
    res.json({ synced: await syncProvider(req.params.id, providerId) });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});
