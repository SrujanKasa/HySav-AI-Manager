// Plan enforcement — the trial/paid model actually gating the product.
// Reads stay open forever (your data is never held hostage), and so does
// anything that REDUCES spend or unlocks payment: deleting tools, billing
// endpoints, notification prefs. Everything that grows the workspace —
// adding/editing tools, reporting usage, imports, invites, integrations —
// requires an active plan and answers 402 with the reason when expired.
import { all, one } from "../db.ts";
import { HttpError } from "../middleware.ts";
import { planStatus, type PlanStatus } from "./billing.ts";

export async function workspacePlanStatus(workspaceId: string, nowIso = new Date().toISOString()): Promise<PlanStatus> {
  const ws = await one<{ created_at: string }>("workspaces", { id: workspaceId });
  if (!ws) throw new HttpError(404, "Workspace not found");
  const paid = await all<{ period_end: string }>(
    "payments",
    { workspace_id: workspaceId, status: "paid" },
    { sort: { period_end: -1 }, limit: 1 },
  );
  return planStatus(ws.created_at, paid[0]?.period_end ?? null, nowIso);
}

/** Throws 402 when the workspace's trial is over and nothing is paid. */
export async function assertPlanWritable(workspaceId: string): Promise<void> {
  const status = await workspacePlanStatus(workspaceId);
  if (!status.active) {
    throw new HttpError(
      402,
      `Your 3-day free trial ended ${status.trialEndsAt.slice(0, 10)} — subscribe to keep adding tools and tracking usage. Your existing data is still readable.`,
    );
  }
}
