// Loads tools + snapshots for a workspace in the plain shapes the waste
// engine consumes. The only bridge between MongoDB documents and pure logic.
import { all } from "../db.ts";
import type { SnapshotInput, ToolInput } from "./waste.ts";

export interface ToolRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  category: string;
  icon: string | null;
  plan: string;
  status: "active" | "trial" | "cancelled";
  cost_cents: number;
  billing_cycle: "monthly" | "annual";
  renewal_date: string;
  credit_limit: number | null;
  credit_unit: string | null;
  usage_source: string;
  note: string | null;
  last_usage_update_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadWorkspaceToolInputs(workspaceId: string): Promise<{
  tools: ToolInput[];
  toolRows: ToolRow[];
  snapshotsByTool: Map<string, SnapshotInput[]>;
}> {
  const toolRows = await all<ToolRow>("tools", { workspace_id: workspaceId }, { sort: { cost_cents: -1 } });
  const toolIds = toolRows.map((t) => t.id);
  const members = await all<{ tool_id: string; user_id: string; last_active_at: string | null }>("tool_members", {
    tool_id: { $in: toolIds },
  });
  const snaps = await all<{ tool_id: string; captured_at: string; used_amount: number; limit_amount: number | null }>(
    "usage_snapshots",
    { tool_id: { $in: toolIds } },
    { sort: { captured_at: 1 } },
  );

  const membersByTool = new Map<string, { userId: string; lastActiveAt: string | null }[]>();
  for (const m of members) {
    const list = membersByTool.get(m.tool_id) ?? [];
    list.push({ userId: m.user_id, lastActiveAt: m.last_active_at });
    membersByTool.set(m.tool_id, list);
  }

  const snapshotsByTool = new Map<string, SnapshotInput[]>();
  for (const s of snaps) {
    const list = snapshotsByTool.get(s.tool_id) ?? [];
    list.push({ capturedAt: s.captured_at, used: s.used_amount, limit: s.limit_amount });
    snapshotsByTool.set(s.tool_id, list);
  }

  const tools: ToolInput[] = toolRows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    status: r.status,
    costCents: r.cost_cents,
    billingCycle: r.billing_cycle,
    renewalDate: r.renewal_date,
    creditLimit: r.credit_limit,
    members: membersByTool.get(r.id) ?? [],
    lastUsageUpdateAt: r.last_usage_update_at,
  }));

  return { tools, toolRows, snapshotsByTool };
}
