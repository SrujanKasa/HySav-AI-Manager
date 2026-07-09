import { Router } from "express";
import { z } from "zod";
import { all, insert, now, one, remove, update, uuid } from "../db.ts";
import { HttpError, currentUser, parseBody, requireAuth, requireMembership } from "../middleware.ts";
import { assertPlanWritable } from "../services/plan.ts";
import type { ToolRow } from "../services/toolData.ts";

export const toolsRouter = Router();
toolsRouter.use(requireAuth);

export const CATEGORIES = [
  "llm-chat",
  "coding-assistant",
  "image-gen",
  "video-gen",
  "copywriting",
  "voice",
  "search",
  "productivity",
  "presentation",
  "other",
] as const;

const toolSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(60)
    .optional(),
  category: z.enum(CATEGORIES),
  icon: z.string().url().max(500).nullish(),
  plan: z.string().max(120).default(""),
  status: z.enum(["active", "trial", "cancelled"]).default("active"),
  costCents: z.number().int().min(0).max(100_000_000),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "ISO date required"),
  creditLimit: z.number().positive().nullish(),
  creditUnit: z.string().max(60).nullish(),
  usageSource: z.enum(["manual", "openai", "anthropic", "vercel"]).default("manual"),
  note: z.string().max(2000).nullish(),
  memberIds: z.array(z.string()).max(100).default([]),
});

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tool";
}

async function getToolChecked(
  req: Parameters<typeof requireMembership>[0],
  toolId: string,
  adminOnly = false,
): Promise<ToolRow> {
  const tool = await one<ToolRow>("tools", { id: toolId });
  if (!tool) throw new HttpError(404, "Tool not found");
  await requireMembership(req, tool.workspace_id, adminOnly);
  return tool;
}

async function setToolMembers(toolId: string, workspaceId: string, memberIds: string[]): Promise<void> {
  await remove("tool_members", { tool_id: toolId });
  for (const userId of new Set(memberIds)) {
    const m = await one("memberships", { user_id: userId, workspace_id: workspaceId });
    if (!m) throw new HttpError(400, `User ${userId} is not a member of this workspace`);
    await insert("tool_members", { tool_id: toolId, user_id: userId, is_owner: 0, last_active_at: now() });
  }
}

/* ---------- CRUD ---------- */

toolsRouter.get("/workspaces/:id/tools", async (req, res) => {
  await requireMembership(req, req.params.id);
  const tools = await all<ToolRow>("tools", { workspace_id: req.params.id }, { sort: { cost_cents: -1 } });
  const members = await all<{ tool_id: string; user_id: string; last_active_at: string | null }>("tool_members", {
    tool_id: { $in: tools.map((t) => t.id) },
  });
  res.json(
    tools.map((t) => ({
      ...serializeTool(t),
      members: members
        .filter((m) => m.tool_id === t.id)
        .map((m) => ({ userId: m.user_id, lastActiveAt: m.last_active_at })),
    })),
  );
});

toolsRouter.post("/workspaces/:id/tools", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await assertPlanWritable(req.params.id);
  const body = parseBody(toolSchema, req.body);
  const id = uuid();
  const ts = now();
  await insert("tools", {
    id,
    workspace_id: req.params.id,
    name: body.name,
    slug: body.slug ?? slugify(body.name),
    category: body.category,
    icon: body.icon ?? null,
    plan: body.plan,
    status: body.status,
    cost_cents: body.costCents,
    billing_cycle: body.billingCycle,
    renewal_date: body.renewalDate,
    credit_limit: body.creditLimit ?? null,
    credit_unit: body.creditUnit ?? null,
    usage_source: body.usageSource,
    note: body.note ?? null,
    last_usage_update_at: null,
    created_at: ts,
    updated_at: ts,
  });
  await setToolMembers(id, req.params.id, body.memberIds);
  res.status(201).json(serializeTool((await one<ToolRow>("tools", { id }))!));
});

toolsRouter.get("/tools/:id", async (req, res) => {
  const tool = await getToolChecked(req, req.params.id);
  const members = (await all<{ user_id: string; last_active_at: string | null }>("tool_members", { tool_id: tool.id })).map(
    (m) => ({ userId: m.user_id, lastActiveAt: m.last_active_at }),
  );
  const snapshots = (
    await all<{ captured_at: string; used_amount: number; limit_amount: number | null; source: string }>(
      "usage_snapshots",
      { tool_id: tool.id },
      { sort: { captured_at: 1 } },
    )
  ).map((s) => ({ capturedAt: s.captured_at, used: s.used_amount, limit: s.limit_amount, source: s.source }));
  res.json({ ...serializeTool(tool), members, snapshots });
});

toolsRouter.patch("/tools/:id", async (req, res) => {
  const tool = await getToolChecked(req, req.params.id, true);
  // note: marking a tool cancelled is still allowed on an expired plan —
  // that's spend REDUCTION, which we never gate
  if (req.body?.status !== "cancelled" || Object.keys(req.body).length > 1) {
    await assertPlanWritable(tool.workspace_id);
  }
  const body = parseBody(toolSchema.partial(), req.body);
  const merged = {
    name: body.name ?? tool.name,
    slug: body.slug ?? tool.slug,
    category: body.category ?? tool.category,
    icon: body.icon === undefined ? tool.icon : body.icon,
    plan: body.plan ?? tool.plan,
    status: body.status ?? tool.status,
    cost_cents: body.costCents ?? tool.cost_cents,
    billing_cycle: body.billingCycle ?? tool.billing_cycle,
    renewal_date: body.renewalDate ?? tool.renewal_date,
    credit_limit: body.creditLimit === undefined ? tool.credit_limit : body.creditLimit,
    credit_unit: body.creditUnit === undefined ? tool.credit_unit : body.creditUnit,
    usage_source: body.usageSource ?? tool.usage_source,
    note: body.note === undefined ? tool.note : body.note,
    updated_at: now(),
  };
  await update("tools", { id: tool.id }, merged);
  if (body.memberIds) await setToolMembers(tool.id, tool.workspace_id, body.memberIds);
  res.json(serializeTool((await one<ToolRow>("tools", { id: tool.id }))!));
});

toolsRouter.delete("/tools/:id", async (req, res) => {
  const tool = await getToolChecked(req, req.params.id, true);
  await remove("usage_snapshots", { tool_id: tool.id });
  await remove("tool_members", { tool_id: tool.id });
  await remove("tools", { id: tool.id });
  res.status(204).end();
});

/* ---------- usage ingestion: manual ---------- */

const usageSchema = z.object({
  used: z.number().min(0),
  limit: z.number().positive().nullish(),
  capturedAt: z.string().datetime().optional(),
});

toolsRouter.post("/tools/:id/usage", async (req, res) => {
  const tool = await getToolChecked(req, req.params.id); // members may report usage
  await assertPlanWritable(tool.workspace_id);
  const body = parseBody(usageSchema, req.body);
  const ts = body.capturedAt ?? now();
  await insert("usage_snapshots", {
    id: uuid(),
    tool_id: tool.id,
    captured_at: ts,
    used_amount: body.used,
    limit_amount: body.limit ?? tool.credit_limit,
    source: "manual",
  });
  await update("tools", { id: tool.id }, { last_usage_update_at: ts, updated_at: now() });
  // reporting usage also marks the reporter's seat active
  const user = currentUser(req);
  await update("tool_members", { tool_id: tool.id, user_id: user.id }, { last_active_at: ts });
  res.status(201).json({ ok: true });
});

/* ---------- usage ingestion: CSV import ----------
   The primary bulk path. Body: text/csv (or JSON {csv: "..."}) with header:
   name,category,cost,billing_cycle,renewal_date,plan,status,credit_limit,credit_unit,used
   One row per tool; creates the tool if the name is new, otherwise appends a
   usage snapshot. Kept dependency-free — quoted fields with commas supported. */

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

toolsRouter.post("/workspaces/:id/tools/import", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  await assertPlanWritable(req.params.id);
  const csv = typeof req.body === "string" ? req.body : (req.body?.csv as string | undefined);
  if (!csv || typeof csv !== "string" || csv.length > 1_000_000) {
    throw new HttpError(400, "Send CSV text (as text/csv body or JSON {\"csv\": ...}), max 1MB");
  }
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new HttpError(400, "CSV needs a header row and at least one data row");

  const results: { name: string; action: "created" | "usage_recorded" | "skipped"; reason?: string }[] = [];
  const ts = now();
  for (const row of rows) {
    const name = row.name;
    if (!name) {
      results.push({ name: "(blank)", action: "skipped", reason: "missing name" });
      continue;
    }
    let tool = await one<ToolRow>("tools", {
      workspace_id: req.params.id,
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    });
    if (!tool) {
      const category = (CATEGORIES as readonly string[]).includes(row.category) ? row.category : "other";
      const costCents = Math.round(Number(row.cost || 0) * 100);
      const cycle = row.billing_cycle === "annual" ? "annual" : "monthly";
      const renewal = /^\d{4}-\d{2}-\d{2}/.test(row.renewal_date)
        ? row.renewal_date
        : new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      if (!Number.isFinite(costCents) || costCents < 0) {
        results.push({ name, action: "skipped", reason: "bad cost" });
        continue;
      }
      const id = uuid();
      await insert("tools", {
        id,
        workspace_id: req.params.id,
        name,
        slug: slugify(name),
        category,
        icon: null,
        plan: row.plan ?? "",
        status: ["active", "trial", "cancelled"].includes(row.status) ? row.status : "active",
        cost_cents: costCents,
        billing_cycle: cycle,
        renewal_date: renewal,
        credit_limit: row.credit_limit ? Number(row.credit_limit) : null,
        credit_unit: row.credit_unit || null,
        usage_source: "manual",
        note: null,
        last_usage_update_at: null,
        created_at: ts,
        updated_at: ts,
      });
      tool = (await one<ToolRow>("tools", { id }))!;
      results.push({ name, action: "created" });
    }
    if (row.used !== undefined && row.used !== "") {
      const used = Number(row.used);
      if (Number.isFinite(used) && used >= 0) {
        await insert("usage_snapshots", {
          id: uuid(),
          tool_id: tool.id,
          captured_at: ts,
          used_amount: used,
          limit_amount: tool.credit_limit,
          source: "csv",
        });
        await update("tools", { id: tool.id }, { last_usage_update_at: ts });
        if (results.at(-1)?.name !== name) results.push({ name, action: "usage_recorded" });
      }
    }
  }
  res.status(201).json({ imported: results });
});

export function serializeTool(t: ToolRow) {
  return {
    id: t.id,
    workspaceId: t.workspace_id,
    name: t.name,
    slug: t.slug,
    category: t.category,
    icon: t.icon,
    plan: t.plan,
    status: t.status,
    costCents: t.cost_cents,
    billingCycle: t.billing_cycle,
    renewalDate: t.renewal_date,
    creditLimit: t.credit_limit,
    creditUnit: t.credit_unit,
    usageSource: t.usage_source,
    note: t.note,
    lastUsageUpdateAt: t.last_usage_update_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}
