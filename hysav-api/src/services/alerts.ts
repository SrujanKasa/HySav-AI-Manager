// Alert scanner + digest builder. Runs on an interval from index.ts (and on
// demand via POST /workspaces/:id/notifications/scan). Respects per-user
// notification_prefs; dedupe keys stop the same alert re-sending every scan.
import { all } from "../db.ts";
import { sendEmail } from "./email.ts";
import { loadWorkspaceToolInputs } from "./toolData.ts";
import { buildWasteReport, monthlyCostCents, type WasteReport } from "./waste.ts";

interface Recipient {
  user_id: string;
  email: string;
  name: string;
  waste_alerts: number;
  renewal_alerts: number;
  weekly_digest: number;
}

async function recipients(workspaceId: string): Promise<Recipient[]> {
  const memberships = await all<{ user_id: string }>("memberships", { workspace_id: workspaceId });
  const userIds = memberships.map((m) => m.user_id);
  const users = await all<{ id: string; email: string; name: string }>("users", { id: { $in: userIds } });
  const prefs = await all<{ user_id: string; waste_alerts: number; renewal_alerts: number; weekly_digest: number }>(
    "notification_prefs",
    { workspace_id: workspaceId },
  );
  return users.map((u) => {
    const p = prefs.find((x) => x.user_id === u.id);
    return {
      user_id: u.id,
      email: u.email,
      name: u.name,
      waste_alerts: p ? p.waste_alerts : 1,
      renewal_alerts: p ? p.renewal_alerts : 1,
      weekly_digest: p ? p.weekly_digest : 1,
    };
  });
}

export async function scanWorkspace(workspaceId: string, nowIso: string): Promise<WasteReport> {
  const { tools, snapshotsByTool } = await loadWorkspaceToolInputs(workspaceId);
  const report = buildWasteReport(tools, snapshotsByTool, nowIso);
  const toolById = new Map(tools.map((t) => [t.id, t]));
  const month = nowIso.slice(0, 7); // one alert per tool+type per month

  for (const flag of report.flags) {
    const tool = toolById.get(flag.toolId);
    if (!tool) continue;

    // upcoming renewal for a tool already flagged as waste/underused
    const daysToRenewal =
      (new Date(tool.renewalDate).getTime() - new Date(nowIso).getTime()) / 86_400_000;
    const isRenewalAlert =
      daysToRenewal <= 7 && (flag.type === "low_usage" || flag.type === "expiring_credits");

    for (const r of await recipients(workspaceId)) {
      if (isRenewalAlert && r.renewal_alerts) {
        await sendEmail({
          workspaceId,
          to: r.email,
          kind: "renewal_alert",
          subject: `[HySav] ${tool.name} renews in ${Math.max(0, Math.ceil(daysToRenewal))} day(s) and looks unused`,
          text: `${flag.message}\n\nRenewal: ${tool.renewalDate.slice(0, 10)} — ${fmt(monthlyCostCents(tool))}/mo.\nReview it: dashboard → ${tool.name}.`,
          dedupeKey: `renewal:${tool.id}:${month}:${r.user_id}`,
        });
      } else if (flag.severity === "red" && r.waste_alerts) {
        await sendEmail({
          workspaceId,
          to: r.email,
          kind: "waste_alert",
          subject: `[HySav] ${tool.name} is trending toward wasted spend`,
          text: `${flag.message}\n\nEstimated waste this month: ${fmt(flag.wastedCentsMonthly)}.`,
          dedupeKey: `waste:${tool.id}:${flag.type}:${month}:${r.user_id}`,
        });
      }
    }
  }
  return report;
}

export async function sendDigest(workspaceId: string, nowIso: string): Promise<void> {
  const { tools, snapshotsByTool } = await loadWorkspaceToolInputs(workspaceId);
  const report = buildWasteReport(tools, snapshotsByTool, nowIso);
  const toolById = new Map(tools.map((t) => [t.id, t]));
  const spend = tools
    .filter((t) => t.status !== "cancelled")
    .reduce((s, t) => s + monthlyCostCents(t), 0);
  const week = weekKey(nowIso);

  const lines = report.tools
    .filter((i) => i.wastedCentsMonthly > 0)
    .sort((a, b) => b.wastedCentsMonthly - a.wastedCentsMonthly)
    .map((i) => `  • ${toolById.get(i.toolId)?.name}: ~${fmt(i.wastedCentsMonthly)}/mo (${i.healthStatus})`);

  const text =
    `Your AI stack this week\n\n` +
    `Monthly spend: ${fmt(spend)}\n` +
    `Estimated waste: ${fmt(report.wastedCentsThisMonth)}\n\n` +
    (lines.length ? `Where it's going:\n${lines.join("\n")}` : "No waste flags this week. Enjoy it.");

  for (const r of await recipients(workspaceId)) {
    if (!r.weekly_digest) continue;
    await sendEmail({
      workspaceId,
      to: r.email,
      kind: "digest",
      subject: `[HySav] Weekly digest — ${fmt(report.wastedCentsThisMonth)} of potential waste`,
      text,
      dedupeKey: `digest:${workspaceId}:${week}:${r.user_id}`,
    });
  }
}

function fmt(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

function weekKey(iso: string): string {
  const d = new Date(iso);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.floor((d.getTime() - jan1.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-w${week}`;
}
