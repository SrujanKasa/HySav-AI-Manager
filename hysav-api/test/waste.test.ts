// Waste-detection engine tests — the core value prop, and the easiest thing
// to get subtly wrong (window deltas across billing resets, double counting,
// duplicate attribution, cost caps).
import { describe, expect, it } from "vitest";
import {
  analyzeTool,
  buildWasteReport,
  computeForecast,
  monthlyCostCents,
  windowUsagePct,
  type SnapshotInput,
  type ToolInput,
} from "../src/services/waste.ts";

const NOW = "2026-07-03T12:00:00.000Z";
const DAY_MS = 86_400_000;

function daysFromNow(n: number): string {
  return new Date(new Date(NOW).getTime() + n * DAY_MS).toISOString();
}

function makeTool(overrides: Partial<ToolInput> = {}): ToolInput {
  return {
    id: "t1",
    name: "TestTool",
    category: "llm-chat",
    status: "active",
    costCents: 10_000, // $100/mo
    billingCycle: "monthly",
    renewalDate: daysFromNow(10), // 20 days into a 30-day period
    creditLimit: 100,
    members: [{ userId: "u1", lastActiveAt: NOW }],
    lastUsageUpdateAt: NOW,
    ...overrides,
  };
}

/** linear snapshot ramp from `fromPct` (daysAgo) to `toPct` (now) */
function ramp(fromPct: number, toPct: number, daysAgo = 30, limit = 100): SnapshotInput[] {
  const snaps: SnapshotInput[] = [];
  for (let i = 0; i <= 10; i++) {
    snaps.push({
      capturedAt: daysFromNow(-daysAgo + (daysAgo * i) / 10),
      used: (fromPct + ((toPct - fromPct) * i) / 10) * (limit / 100),
      limit,
    });
  }
  return snaps;
}

describe("monthlyCostCents", () => {
  it("normalizes annual billing to a monthly figure", () => {
    expect(monthlyCostCents({ costCents: 120_000, billingCycle: "annual" })).toBe(10_000);
    expect(monthlyCostCents({ costCents: 10_000, billingCycle: "monthly" })).toBe(10_000);
  });
});

describe("computeForecast", () => {
  it("projects linear burn to the end of the period", () => {
    const tool = makeTool(); // 20 of 30 days elapsed
    const f = computeForecast(tool, ramp(0, 40), NOW);
    expect(f.pctUsed).toBeCloseTo(40, 0);
    expect(f.daysElapsed).toBeCloseTo(20, 0);
    expect(f.projectedPctAtRenewal).toBeCloseTo(60, 0);
    expect(f.classification).toBe("on-pace");
  });

  it("classifies heavy burn as overrun and light burn as underuse", () => {
    const tool = makeTool();
    expect(computeForecast(tool, ramp(0, 90), NOW).classification).toBe("overrun"); // → 135%
    expect(computeForecast(tool, ramp(0, 20), NOW).classification).toBe("underuse"); // → 30%
  });

  it("returns unknown when the tool has no usable limit", () => {
    const tool = makeTool({ creditLimit: null });
    const f = computeForecast(tool, [{ capturedAt: NOW, used: 10, limit: null }], NOW);
    expect(f.classification).toBe("unknown");
  });
});

describe("windowUsagePct", () => {
  it("measures the delta inside the window, not lifetime usage", () => {
    // 60% used overall, but only 2% of it happened in the last 30 days
    const pct = windowUsagePct(ramp(58, 60), NOW, 30);
    expect(pct).toBeCloseTo(2, 0);
  });

  it("survives a billing-period reset (negative delta)", () => {
    const snaps: SnapshotInput[] = [
      { capturedAt: daysFromNow(-20), used: 90, limit: 100 }, // last period
      { capturedAt: daysFromNow(-1), used: 4, limit: 100 }, //   reset happened
    ];
    expect(windowUsagePct(snaps, NOW, 30)).toBeCloseTo(4, 0);
  });
});

describe("analyzeTool — rule flags", () => {
  it("flags near-zero recent usage as red waste", () => {
    const tool = makeTool();
    const ins = analyzeTool(tool, ramp(9, 10), NOW); // 1% in the window
    expect(ins.flags.some((f) => f.type === "low_usage" && f.severity === "red")).toBe(true);
    expect(ins.healthStatus).toBe("waste");
    // ~$100 * (1 - ~15% projected) ≈ $85 — sanity band, exact rounding aside
    expect(ins.wastedCentsMonthly).toBeGreaterThan(8_000);
    expect(ins.wastedCentsMonthly).toBeLessThanOrEqual(10_000);
  });

  it("flags credits on track to expire unused (but above the low-usage bar)", () => {
    const tool = makeTool();
    const ins = analyzeTool(tool, ramp(0, 20), NOW); // projected 30%
    const flag = ins.flags.find((f) => f.type === "expiring_credits");
    expect(flag).toBeDefined();
    expect(flag!.wastedCentsMonthly).toBeCloseTo(7_000, -2); // $100 * 70% unused
    expect(ins.healthStatus).toBe("under");
  });

  it("does not double-count low_usage and expiring_credits", () => {
    const tool = makeTool();
    const ins = analyzeTool(tool, ramp(9, 10), NOW);
    expect(ins.flags.filter((f) => f.type === "low_usage" || f.type === "expiring_credits")).toHaveLength(1);
  });

  it("does not forecast off the first days of a period", () => {
    // only 2 of 30 days elapsed, 1% used → too early to call it expiring
    const tool = makeTool({ renewalDate: daysFromNow(28) });
    const snaps: SnapshotInput[] = [
      { capturedAt: daysFromNow(-40), used: 80, limit: 100 },
      { capturedAt: daysFromNow(-1), used: 1, limit: 100 },
    ];
    const ins = analyzeTool(tool, snaps, NOW);
    expect(ins.flags.some((f) => f.type === "expiring_credits")).toBe(false);
  });

  it("treats overruns as an upgrade heads-up, never waste", () => {
    const tool = makeTool();
    const ins = analyzeTool(tool, ramp(0, 90), NOW); // projected 135%
    const cap = ins.flags.find((f) => f.type === "cap_approaching");
    expect(cap).toBeDefined();
    expect(cap!.wastedCentsMonthly).toBe(0);
    expect(ins.healthStatus).toBe("healthy");
  });

  it("flags forgotten tools (no usage report in 45+ days)", () => {
    const tool = makeTool({ lastUsageUpdateAt: daysFromNow(-50) });
    const ins = analyzeTool(tool, ramp(0, 50, 60), NOW);
    expect(ins.flags.some((f) => f.type === "forgotten")).toBe(true);
  });

  it("prices idle seats at their share of the monthly cost", () => {
    const tool = makeTool({
      costCents: 6_000,
      members: [
        { userId: "a", lastActiveAt: NOW },
        { userId: "b", lastActiveAt: NOW },
        { userId: "c", lastActiveAt: daysFromNow(-40) }, // idle
      ],
    });
    const ins = analyzeTool(tool, ramp(0, 50), NOW);
    const flag = ins.flags.find((f) => f.type === "idle_seats");
    expect(flag).toBeDefined();
    expect(flag!.wastedCentsMonthly).toBe(2_000); // $60 / 3 seats
  });

  it("ignores cancelled tools entirely", () => {
    const tool = makeTool({ status: "cancelled" });
    const ins = analyzeTool(tool, ramp(9, 10), NOW);
    expect(ins.flags).toHaveLength(0);
    expect(ins.wastedCentsMonthly).toBe(0);
  });

  it("caps per-tool waste at the tool's monthly cost", () => {
    const tool = makeTool({
      costCents: 5_000,
      members: [
        { userId: "a", lastActiveAt: NOW },
        { userId: "b", lastActiveAt: daysFromNow(-40) },
      ],
    });
    const ins = analyzeTool(tool, ramp(9, 10), NOW); // low_usage + idle seat
    expect(ins.wastedCentsMonthly).toBeLessThanOrEqual(5_000);
  });
});

describe("buildWasteReport — duplicates & totals", () => {
  it("flags same-category tools paid for by disjoint users", () => {
    const jasper = makeTool({ id: "jasper", name: "Jasper", category: "copywriting", costCents: 5_900, members: [{ userId: "priya", lastActiveAt: NOW }] });
    const copyai = makeTool({ id: "copyai", name: "Copy.ai", category: "copywriting", costCents: 4_900, members: [{ userId: "sam", lastActiveAt: NOW }] });
    const snaps = new Map([
      ["jasper", ramp(0, 9)],
      ["copyai", ramp(0, 24)],
    ]);
    const report = buildWasteReport([jasper, copyai], snaps, NOW);
    const dupFlags = report.flags.filter((f) => f.type === "duplicate");
    expect(dupFlags).toHaveLength(2);
    // redundant spend = cheaper tool, attributed once (to the least-used tool)
    expect(dupFlags.reduce((s, f) => s + f.wastedCentsMonthly, 0)).toBe(4_900);
    expect(dupFlags.find((f) => f.toolId === "jasper")!.wastedCentsMonthly).toBe(4_900);
    expect(report.tools.every((t) => t.healthStatus === "dup")).toBe(true);
  });

  it("does NOT flag same-category tools shared by the same people", () => {
    const shared = [{ userId: "maya", lastActiveAt: NOW }, { userId: "dev", lastActiveAt: NOW }];
    const chatgpt = makeTool({ id: "cg", name: "ChatGPT", category: "llm-chat", members: shared });
    const claude = makeTool({ id: "cl", name: "Claude", category: "llm-chat", members: [shared[0]] });
    const snaps = new Map([
      ["cg", ramp(0, 60)],
      ["cl", ramp(0, 70)],
    ]);
    const report = buildWasteReport([chatgpt, claude], snaps, NOW);
    expect(report.flags.some((f) => f.type === "duplicate")).toBe(false);
  });

  it("totals workspace waste across rules without double counting", () => {
    const idle = makeTool({
      id: "idle-tool",
      costCents: 6_000,
      members: [
        { userId: "a", lastActiveAt: NOW },
        { userId: "b", lastActiveAt: NOW },
        { userId: "c", lastActiveAt: daysFromNow(-40) },
      ],
    });
    const dead = makeTool({ id: "dead-tool", category: "video-gen", costCents: 7_600, members: [{ userId: "a", lastActiveAt: NOW }] });
    const snaps = new Map([
      ["idle-tool", ramp(0, 50)],
      ["dead-tool", ramp(5, 6)],
    ]);
    const report = buildWasteReport([idle, dead], snaps, NOW);
    const idleIns = report.tools.find((t) => t.toolId === "idle-tool")!;
    const deadIns = report.tools.find((t) => t.toolId === "dead-tool")!;
    expect(report.wastedCentsThisMonth).toBe(idleIns.wastedCentsMonthly + deadIns.wastedCentsMonthly);
    expect(idleIns.wastedCentsMonthly).toBe(2_000);
    expect(deadIns.wastedCentsMonthly).toBeGreaterThan(6_000);
  });
});
