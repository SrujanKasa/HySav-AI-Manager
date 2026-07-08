// Waste/insights + dashboard endpoints. /dashboard returns exactly the shape
// the frontend demo renders (members keyed by initials, tools with usage %,
// alerts) so the static site swaps mock data for this with no re-render work.
import { Router } from "express";
import { all, one } from "../db.ts";
import { HttpError, requireAuth, requireMembership } from "../middleware.ts";
import { scanWorkspace, sendDigest } from "../services/alerts.ts";
import { loadWorkspaceToolInputs, type ToolRow } from "../services/toolData.ts";
import {
  buildWasteReport,
  monthlyCostCents,
  type ToolInsight,
  type WasteReport,
} from "../services/waste.ts";

export const insightsRouter = Router();
export const demoRouter = Router();

insightsRouter.use(requireAuth);

insightsRouter.get("/workspaces/:id/insights", async (req, res) => {
  await requireMembership(req, req.params.id);
  res.json(await buildInsights(req.params.id));
});

insightsRouter.get("/workspaces/:id/dashboard", async (req, res) => {
  await requireMembership(req, req.params.id);
  res.json(await buildDashboard(req.params.id));
});

// on-demand alert scan + digest (also run on a timer in index.ts)
insightsRouter.post("/workspaces/:id/notifications/scan", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  const report = await scanWorkspace(req.params.id, new Date().toISOString());
  res.json({ scanned: true, flags: report.flags.length });
});

insightsRouter.post("/workspaces/:id/notifications/digest", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await sendDigest(req.params.id, new Date().toISOString());
  res.json({ sent: true });
});

/* ---------- public, read-only demo dashboard ----------
   Serves the seeded "Otterworks" workspace so the marketing site's live demo
   runs on real backend data with real waste math — no auth, no writes. */
demoRouter.get("/dashboard", async (_req, res) => {
  const ws = await one<{ id: string }>("workspaces", { name: "Otterworks Inc." });
  if (!ws) throw new HttpError(503, "Demo workspace not seeded");
  res.json(await buildDashboard(ws.id));
});

/* ---------- shared builders ---------- */

async function buildInsights(workspaceId: string): Promise<{
  report: { wastedCentsThisMonth: number; monthlySpendCents: number };
  tools: (ToolInsight & { name: string })[];
  flags: WasteReport["flags"];
}> {
  const { tools, snapshotsByTool } = await loadWorkspaceToolInputs(workspaceId);
  const report = buildWasteReport(tools, snapshotsByTool, new Date().toISOString());
  const nameById = new Map(tools.map((t) => [t.id, t.name]));
  return {
    report: {
      wastedCentsThisMonth: report.wastedCentsThisMonth,
      monthlySpendCents: tools
        .filter((t) => t.status !== "cancelled")
        .reduce((s, t) => s + monthlyCostCents(t), 0),
    },
    tools: report.tools.map((t) => ({ ...t, name: nameById.get(t.toolId) ?? "" })),
    flags: report.flags,
  };
}

export async function buildDashboard(workspaceId: string) {
  const { tools, toolRows, snapshotsByTool } = await loadWorkspaceToolInputs(workspaceId);
  const report = buildWasteReport(tools, snapshotsByTool, new Date().toISOString());
  const insightByTool = new Map(report.tools.map((t) => [t.toolId, t]));
  const rowById = new Map(toolRows.map((r) => [r.id, r]));

  const memberships = await all<{ user_id: string; initials: string; color: string; title: string }>("memberships", {
    workspace_id: workspaceId,
  });
  const users = await all<{ id: string; name: string }>("users", {
    id: { $in: memberships.map((m) => m.user_id) },
  });
  const initialsByUser = new Map(memberships.map((m) => [m.user_id, m.initials]));

  const members: Record<string, { name: string; role: string; color: string }> = {};
  for (const m of memberships) {
    const u = users.find((x) => x.id === m.user_id);
    members[m.initials] = { name: u?.name ?? "", role: m.title, color: m.color };
  }

  const nowMs = Date.now();
  const dashTools = tools
    .filter((t) => t.status !== "cancelled")
    .map((t) => {
      const row = rowById.get(t.id)!;
      const ins = insightByTool.get(t.id)!;
      const idle = t.members
        .filter((m) => !m.lastActiveAt || nowMs - new Date(m.lastActiveAt).getTime() >= 30 * 86_400_000)
        .map((m) => initialsByUser.get(m.userId))
        .filter((x): x is string => !!x);
      return {
        id: row.slug,
        name: t.name,
        plan: row.plan,
        cost: Math.round(monthlyCostCents(t) / 100),
        usage: Math.round(ins.forecast.pctUsed),
        unit: row.credit_unit ?? "usage",
        resetsIn: Math.max(0, Math.ceil((new Date(t.renewalDate).getTime() - nowMs) / 86_400_000)),
        status: ins.healthStatus,
        note: row.note ?? generatedNote(ins),
        users: t.members.map((m) => initialsByUser.get(m.userId)).filter((x): x is string => !!x),
        idle,
        wasted: Math.round(ins.wastedCentsMonthly / 100),
      };
    });

  const alerts = buildAlerts(report, rowById);

  return { members, tools: dashTools, alerts };
}

function generatedNote(ins: ToolInsight): string {
  if (ins.flags.length === 0) return "Usage is on pace for this billing period. Nothing to do here.";
  return ins.flags.map((f) => f.message).join(" ");
}

function buildAlerts(report: WasteReport, rowById: Map<string, ToolRow>) {
  const icons: Record<string, string> = {
    low_usage: "flame",
    expiring_credits: "hourglass",
    duplicate: "copy",
    forgotten: "ghost",
    idle_seats: "user-x",
    cap_approaching: "trending-up",
  };
  // one alert per flag type, highest-waste first, duplicate groups collapsed
  const seen = new Set<string>();
  const alerts: { id: string; sev: string; ico: string; html: string }[] = [];
  const flags = [...report.flags].sort((a, b) => b.wastedCentsMonthly - a.wastedCentsMonthly);
  for (const f of flags) {
    const key = f.type === "duplicate" ? "duplicate" : `${f.type}:${f.toolId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = rowById.get(f.toolId)?.name ?? "";
    alerts.push({
      id: `${f.type}-${f.toolId}`,
      sev: f.severity === "red" ? "red" : f.severity === "amber" ? "amber" : "info",
      ico: icons[f.type] ?? "bell",
      html: `<strong>${name ? name + ": " : ""}${escapeHtml(headline(f.type))}</strong> ${escapeHtml(stripName(f.message, name))}`,
    });
    if (alerts.length >= 4) break;
  }
  return alerts;
}

function headline(type: string): string {
  switch (type) {
    case "low_usage": return "barely used.";
    case "expiring_credits": return "credits expiring unused.";
    case "duplicate": return "duplicate tools detected.";
    case "forgotten": return "possibly forgotten.";
    case "idle_seats": return "idle seats.";
    case "cap_approaching": return "approaching its cap.";
    default: return "needs attention.";
  }
}

function stripName(message: string, name: string): string {
  return name && message.startsWith(`${name}: `) ? message.slice(name.length + 2) : message;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
