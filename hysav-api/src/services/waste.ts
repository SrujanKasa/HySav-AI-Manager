// Waste-detection engine — the core value prop. Pure functions over plain
// data so the logic is unit-testable without a database. All money values
// are integer cents, normalized to a monthly basis.
//
// Rules implemented:
//   1. low_usage         — under LOW_USAGE_PCT of credits consumed in the last
//                          LOW_USAGE_WINDOW_DAYS, based on snapshot deltas.
//   2. expiring_credits  — linear burn forecast says a large share of this
//                          period's credits will expire unused.
//   3. duplicate         — 2+ active tools in the same category inside one
//                          workspace (simple category matching, per spec).
//   4. forgotten         — still marked active but no usage report in
//                          FORGOTTEN_AFTER_DAYS (proxy for "nobody looks at it").
//   5. idle_seats        — assigned members with no activity in
//                          IDLE_SEAT_AFTER_DAYS; their seat-share of cost is waste.
// Plus an informational 'cap_approaching' signal (forecast overrun) which is
// NOT counted as waste — running out of credits early is an upgrade signal.

export interface ToolMemberInput {
  userId: string;
  lastActiveAt: string | null; // ISO
}

export interface ToolInput {
  id: string;
  name: string;
  category: string;
  status: "active" | "trial" | "cancelled";
  costCents: number;
  billingCycle: "monthly" | "annual";
  renewalDate: string; // ISO date of next renewal
  creditLimit: number | null;
  members: ToolMemberInput[];
  lastUsageUpdateAt: string | null;
}

export interface SnapshotInput {
  capturedAt: string; // ISO
  used: number;
  limit: number | null;
}

export interface Forecast {
  pctUsed: number; // latest snapshot, % of limit
  daysElapsed: number;
  periodDays: number;
  dailyBurnPct: number;
  projectedPctAtRenewal: number;
  classification: "on-pace" | "overrun" | "underuse" | "unknown";
}

export type FlagType =
  | "low_usage"
  | "expiring_credits"
  | "duplicate"
  | "forgotten"
  | "idle_seats"
  | "cap_approaching";

export interface WasteFlag {
  toolId: string;
  type: FlagType;
  severity: "red" | "amber" | "info";
  message: string;
  wastedCentsMonthly: number; // 0 for purely informational flags
}

export interface ToolInsight {
  toolId: string;
  healthStatus: "healthy" | "under" | "waste" | "dup";
  wastedCentsMonthly: number;
  forecast: Forecast;
  flags: WasteFlag[];
}

export interface WasteReport {
  tools: ToolInsight[];
  flags: WasteFlag[];
  wastedCentsThisMonth: number;
}

export const RULES = {
  LOW_USAGE_PCT: 5,
  LOW_USAGE_WINDOW_DAYS: 30,
  EXPIRING_PROJECTED_PCT: 50, // projected end-of-period usage below this ⇒ credits expiring unused
  EXPIRING_MIN_ELAPSED: 0.25, // don't forecast off the first few days of a period
  SEVERE_PROJECTED_PCT: 15, //  below this the tool is outright waste, not just underused
  FORGOTTEN_AFTER_DAYS: 45,
  IDLE_SEAT_AFTER_DAYS: 30,
  CAP_PROJECTED_PCT: 110, // projected overrun ⇒ heads-up to upgrade
} as const;

const DAY_MS = 86_400_000;

export function monthlyCostCents(tool: Pick<ToolInput, "costCents" | "billingCycle">): number {
  return tool.billingCycle === "annual" ? Math.round(tool.costCents / 12) : tool.costCents;
}

function daysBetween(a: string | Date, b: string | Date): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

export function computeForecast(tool: ToolInput, snapshots: SnapshotInput[], nowIso: string): Forecast {
  const periodDays = tool.billingCycle === "annual" ? 365 : 30;
  const daysToRenewal = Math.max(0, daysBetween(nowIso, tool.renewalDate));
  const daysElapsed = Math.min(periodDays, Math.max(0, periodDays - daysToRenewal));

  const latest = snapshots.at(-1);
  const limit = latest?.limit ?? tool.creditLimit;
  if (!latest || !limit || limit <= 0) {
    return {
      pctUsed: 0,
      daysElapsed,
      periodDays,
      dailyBurnPct: 0,
      projectedPctAtRenewal: 0,
      classification: "unknown",
    };
  }

  const pctUsed = Math.min(100, (latest.used / limit) * 100);
  const dailyBurnPct = daysElapsed > 0 ? pctUsed / daysElapsed : 0;
  const projectedPctAtRenewal = daysElapsed > 0 ? Math.min(200, dailyBurnPct * periodDays) : pctUsed;

  let classification: Forecast["classification"] = "on-pace";
  if (projectedPctAtRenewal >= RULES.CAP_PROJECTED_PCT) classification = "overrun";
  else if (projectedPctAtRenewal < RULES.EXPIRING_PROJECTED_PCT) classification = "underuse";

  return { pctUsed, daysElapsed, periodDays, dailyBurnPct, projectedPctAtRenewal, classification };
}

/** Usage consumed within the trailing window, as % of limit (snapshot deltas). */
export function windowUsagePct(snapshots: SnapshotInput[], nowIso: string, windowDays: number): number | null {
  const latest = snapshots.at(-1);
  const limit = latest?.limit;
  if (!latest || !limit || limit <= 0) return null;
  const cutoff = new Date(new Date(nowIso).getTime() - windowDays * DAY_MS).toISOString();
  // Earliest snapshot inside the window; usage resets each billing period, so
  // a negative delta (reset happened) is treated as "just what's used now".
  const inWindow = snapshots.filter((s) => s.capturedAt >= cutoff);
  if (inWindow.length === 0) return null;
  // a single reading has no delta — take it as the window's absolute usage
  if (inWindow.length === 1) return (latest.used / limit) * 100;
  const delta = latest.used - inWindow[0].used;
  const used = delta >= 0 ? delta : latest.used;
  return (used / limit) * 100;
}

function fmtMoney(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

export function analyzeTool(tool: ToolInput, snapshots: SnapshotInput[], nowIso: string): ToolInsight {
  const flags: WasteFlag[] = [];
  const forecast = computeForecast(tool, snapshots, nowIso);
  const monthly = monthlyCostCents(tool);

  if (tool.status === "cancelled") {
    return { toolId: tool.id, healthStatus: "healthy", wastedCentsMonthly: 0, forecast, flags };
  }

  // 1. near-zero recent usage
  const recentPct = windowUsagePct(snapshots, nowIso, RULES.LOW_USAGE_WINDOW_DAYS);
  if (recentPct !== null && recentPct < RULES.LOW_USAGE_PCT) {
    // clamp: a fresh tool's forecast can project >100%, which must never
    // turn "wasted spend" negative
    const unusedShare = Math.max(0, 1 - Math.max(forecast.projectedPctAtRenewal, recentPct) / 100);
    const wasted = Math.round(monthly * unusedShare);
    flags.push({
      toolId: tool.id,
      type: "low_usage",
      severity: "red",
      message: `${tool.name}: under ${RULES.LOW_USAGE_PCT}% of credits used in the last ${RULES.LOW_USAGE_WINDOW_DAYS} days${tool.status === "trial" ? " (converted trial)" : ""}.`,
      wastedCentsMonthly: wasted,
    });
  }

  // 2. credits on track to expire unused
  const elapsedFraction = forecast.periodDays > 0 ? forecast.daysElapsed / forecast.periodDays : 0;
  if (
    forecast.classification === "underuse" &&
    elapsedFraction >= RULES.EXPIRING_MIN_ELAPSED &&
    !flags.some((f) => f.type === "low_usage") // don't double-count
  ) {
    flags.push({
      toolId: tool.id,
      type: "expiring_credits",
      severity: "amber",
      message: `${tool.name}: on pace to end the period at ~${Math.round(forecast.projectedPctAtRenewal)}% of credits — the rest expires.`,
      wastedCentsMonthly: Math.round(monthly * (1 - forecast.projectedPctAtRenewal / 100)),
    });
  }

  // heads-up (not waste): burning credits faster than the period
  if (forecast.classification === "overrun") {
    flags.push({
      toolId: tool.id,
      type: "cap_approaching",
      severity: "info",
      message: `${tool.name}: on pace to hit its usage cap before renewal — consider the next tier instead of paying overage.`,
      wastedCentsMonthly: 0,
    });
  }

  // 4. forgotten: active but nobody has reported/synced usage in a long time
  if (tool.lastUsageUpdateAt) {
    const staleDays = daysBetween(tool.lastUsageUpdateAt, nowIso);
    if (staleDays >= RULES.FORGOTTEN_AFTER_DAYS) {
      flags.push({
        toolId: tool.id,
        type: "forgotten",
        severity: "amber",
        message: `${tool.name}: no usage reported in ${Math.floor(staleDays)} days — still worth paying for?`,
        wastedCentsMonthly: 0,
      });
    }
  }

  // 5. idle seats: seat-share of cost for members inactive 30+ days
  const seatCount = tool.members.length;
  if (seatCount > 1) {
    const idle = tool.members.filter(
      (m) => !m.lastActiveAt || daysBetween(m.lastActiveAt, nowIso) >= RULES.IDLE_SEAT_AFTER_DAYS,
    );
    if (idle.length > 0 && idle.length < seatCount) {
      const perSeat = Math.round(monthly / seatCount);
      flags.push({
        toolId: tool.id,
        type: "idle_seats",
        severity: "amber",
        message: `${tool.name}: ${idle.length} of ${seatCount} seats idle 30+ days (~${fmtMoney(perSeat * idle.length)}/mo).`,
        wastedCentsMonthly: perSeat * idle.length,
      });
    }
  }

  // per-tool waste is bounded to [0, monthly cost] no matter what the rules sum to
  const wastedCentsMonthly = Math.max(
    0,
    Math.min(
      monthly,
      flags.reduce((s, f) => s + f.wastedCentsMonthly, 0),
    ),
  );

  const healthStatus: ToolInsight["healthStatus"] = flags.some(
    (f) => f.type === "low_usage" || (f.type === "expiring_credits" && forecast.projectedPctAtRenewal < RULES.SEVERE_PROJECTED_PCT),
  )
    ? "waste"
    : flags.some((f) => f.type === "expiring_credits" || f.type === "idle_seats" || f.type === "forgotten")
      ? "under"
      : "healthy";

  return { toolId: tool.id, healthStatus, wastedCentsMonthly, forecast, flags };
}

export function buildWasteReport(
  tools: ToolInput[],
  snapshotsByTool: Map<string, SnapshotInput[]>,
  nowIso: string,
): WasteReport {
  const insights = new Map<string, ToolInsight>();
  for (const tool of tools) {
    insights.set(tool.id, analyzeTool(tool, snapshotsByTool.get(tool.id) ?? [], nowIso));
  }

  // duplicates are a workspace-level rule
  const byCategory = new Map<string, ToolInput[]>();
  for (const t of tools) {
    if (t.status === "cancelled") continue;
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  for (const [, categoryGroup] of byCategory) {
    if (categoryGroup.length < 2) continue;
    // Per spec, duplication means "two team members separately paying for
    // similar tools". Two LLM chats shared by the same people is a deliberate
    // choice, not waste — so only flag tools whose user sets are disjoint.
    const flagged = new Set<ToolInput>();
    for (let i = 0; i < categoryGroup.length; i++) {
      for (let j = i + 1; j < categoryGroup.length; j++) {
        const a = categoryGroup[i];
        const b = categoryGroup[j];
        if (a.members.length === 0 || b.members.length === 0) continue;
        const aUsers = new Set(a.members.map((m) => m.userId));
        if (!b.members.some((m) => aUsers.has(m.userId))) {
          flagged.add(a);
          flagged.add(b);
        }
      }
    }
    if (flagged.size < 2) continue;
    const group = [...flagged];
    const cheapest = Math.min(...group.map(monthlyCostCents));
    // attribute the redundant spend to the least-used tool in the group
    const leastUsed = group.reduce((a, b) =>
      (insights.get(a.id)?.forecast.pctUsed ?? 0) <= (insights.get(b.id)?.forecast.pctUsed ?? 0) ? a : b,
    );
    const names = group.map((t) => t.name).join(" + ");
    for (const t of group) {
      const flag: WasteFlag = {
        toolId: t.id,
        type: "duplicate",
        severity: "amber",
        message: `Overlap: ${names} are both "${t.category}" tools — keeping one saves ~${fmtMoney(cheapest)}/mo.`,
        wastedCentsMonthly: t.id === leastUsed.id ? cheapest : 0,
      };
      const ins = insights.get(t.id);
      if (ins) {
        ins.flags.push(flag);
        ins.healthStatus = "dup";
        ins.wastedCentsMonthly = Math.min(
          monthlyCostCents(t),
          ins.wastedCentsMonthly + flag.wastedCentsMonthly,
        );
      }
    }
  }

  const allInsights = [...insights.values()];
  return {
    tools: allInsights,
    flags: allInsights.flatMap((i) => i.flags),
    wastedCentsThisMonth: allInsights.reduce((s, i) => s + i.wastedCentsMonthly, 0),
  };
}
