// Live-integration credentials + sync. Keys are AES-256-GCM encrypted at
// rest, only the last 4 chars are ever returned, and plaintext keys are
// never logged (see also errorHandler, which never echoes internals).
import { Router } from "express";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../crypto.ts";
import { all, now, one, run, uuid } from "../db.ts";
import { HttpError, currentUser, parseBody, requireAuth, requireMembership } from "../middleware.ts";
import { providers } from "../providers/index.ts";
import type { ToolRow } from "../services/toolData.ts";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

integrationsRouter.get("/workspaces/:id/integrations", (req, res) => {
  requireMembership(req, req.params.id);
  const rows = all<{ id: string; provider: string; key_last4: string; created_at: string; last_synced_at: string | null }>(
    "SELECT id, provider, key_last4, created_at, last_synced_at FROM integration_credentials WHERE workspace_id = ?",
    req.params.id,
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
  provider: z.enum(["openai", "anthropic", "vercel"]),
  apiKey: z.string().min(8).max(500),
});

integrationsRouter.post("/workspaces/:id/integrations", (req, res) => {
  requireMembership(req, req.params.id, true);
  const user = currentUser(req);
  const body = parseBody(connectSchema, req.body);
  const p = providers[body.provider];
  if (!p.supportsLiveSync) {
    throw new HttpError(400, `${p.displayName}: ${p.integrationStatus}`);
  }
  const id = uuid();
  run(
    `INSERT INTO integration_credentials (id, workspace_id, provider, key_ciphertext, key_last4, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext, key_last4 = excluded.key_last4,
       created_by = excluded.created_by, created_at = excluded.created_at`,
    id,
    req.params.id,
    body.provider,
    encryptSecret(body.apiKey),
    body.apiKey.slice(-4),
    user.id,
    now(),
  );
  res.status(201).json({ provider: body.provider, keyLast4: body.apiKey.slice(-4) });
});

integrationsRouter.delete("/workspaces/:id/integrations/:provider", (req, res) => {
  requireMembership(req, req.params.id, true);
  run(
    "DELETE FROM integration_credentials WHERE workspace_id = ? AND provider = ?",
    req.params.id,
    req.params.provider,
  );
  res.status(204).end();
});

/** Pull fresh usage from the provider API for every tool in the workspace
 *  whose usage_source matches. The reading lands in usage_snapshots exactly
 *  like a manual entry would — same table, same downstream logic. */
integrationsRouter.post("/workspaces/:id/integrations/:provider/sync", async (req, res) => {
  requireMembership(req, req.params.id, true);
  const providerId = req.params.provider;
  const p = providers[providerId];
  if (!p) throw new HttpError(404, "Unknown provider");
  if (!p.supportsLiveSync || !p.sync) throw new HttpError(400, `${p.displayName}: ${p.integrationStatus}`);

  const cred = one<{ key_ciphertext: string }>(
    "SELECT key_ciphertext FROM integration_credentials WHERE workspace_id = ? AND provider = ?",
    req.params.id,
    providerId,
  );
  if (!cred) throw new HttpError(400, `No ${p.displayName} credential connected for this workspace`);

  const tools = all<ToolRow>(
    "SELECT * FROM tools WHERE workspace_id = ? AND usage_source = ? AND status != 'cancelled'",
    req.params.id,
    providerId,
  );
  if (tools.length === 0) {
    throw new HttpError(400, `No tools in this workspace have usage_source='${providerId}'`);
  }

  const apiKey = decryptSecret(cred.key_ciphertext);
  const results: { toolId: string; name: string; ok: boolean; used?: number; error?: string }[] = [];
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
      run(
        `INSERT INTO usage_snapshots (id, tool_id, captured_at, used_amount, limit_amount, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        uuid(),
        tool.id,
        reading.capturedAt,
        reading.used,
        reading.limit,
        providerId,
      );
      run("UPDATE tools SET last_usage_update_at = ?, updated_at = ? WHERE id = ?", reading.capturedAt, now(), tool.id);
      results.push({ toolId: tool.id, name: tool.name, ok: true, used: reading.used });
    } catch (err) {
      // provider errors surface per-tool; the message never includes the key
      results.push({ toolId: tool.id, name: tool.name, ok: false, error: (err as Error).message });
    }
  }
  run("UPDATE integration_credentials SET last_synced_at = ? WHERE workspace_id = ? AND provider = ?", now(), req.params.id, providerId);
  res.json({ synced: results });
});
