import { Router } from "express";
import { z } from "zod";
import { all, now, one, run, uuid } from "../db.ts";
import { HttpError, currentUser, parseBody, requireAuth, requireMembership } from "../middleware.ts";
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

function getToolChecked(req: Parameters<typeof requireMembership>[0], toolId: string, adminOnly = false): ToolRow {
  const tool = one<ToolRow>("SELECT * FROM tools WHERE id = ?", toolId);
  if (!tool) throw new HttpError(404, "Tool not found");
  requireMembership(req, tool.workspace_id, adminOnly);
  return tool;
}

function setToolMembers(toolId: string, workspaceId: string, memberIds: string[]): void {
  run("DELETE FROM tool_members WHERE tool_id = ?", toolId);
  for (const userId of new Set(memberIds)) {
    const m = one("SELECT 1 AS x FROM memberships WHERE user_id = ? AND workspace_id = ?", userId, workspaceId);
    if (!m) throw new HttpError(400, `User ${userId} is not a member of this workspace`);
    run("INSERT INTO tool_members (tool_id, user_id, is_owner, last_active_at) VALUES (?, ?, 0, ?)", toolId, userId, now());
  }
}

/* ---------- CRUD ---------- */

toolsRouter.get("/workspaces/:id/tools", (req, res) => {
  requireMembership(req, req.params.id);
  const tools = all<ToolRow>("SELECT * FROM tools WHERE workspace_id = ? ORDER BY cost_cents DESC", req.params.id);
  const members = all<{ tool_id: string; user_id: string; last_active_at: string | null }>(
    `SELECT tm.tool_id, tm.user_id, tm.last_active_at FROM tool_members tm
     JOIN tools t ON t.id = tm.tool_id WHERE t.workspace_id = ?`,
    req.params.id,
  );
  res.json(
    tools.map((t) => ({
      ...serializeTool(t),
      members: members.filter((m) => m.tool_id === t.id).map((m) => ({ userId: m.user_id, lastActiveAt: m.last_active_at })),
    })),
  );
});

toolsRouter.post("/workspaces/:id/tools", (req, res) => {
  requireMembership(req, req.params.id, true);
  const body = parseBody(toolSchema, req.body);
  const id = uuid();
  const ts = now();
  run(
    `INSERT INTO tools (id, workspace_id, name, slug, category, icon, plan, status, cost_cents, billing_cycle,
                        renewal_date, credit_limit, credit_unit, usage_source, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    req.params.id,
    body.name,
    body.slug ?? slugify(body.name),
    body.category,
    body.icon ?? null,
    body.plan,
    body.status,
    body.costCents,
    body.billingCycle,
    body.renewalDate,
    body.creditLimit ?? null,
    body.creditUnit ?? null,
    body.usageSource,
    body.note ?? null,
    ts,
    ts,
  );
  setToolMembers(id, req.params.id, body.memberIds);
  res.status(201).json(serializeTool(one<ToolRow>("SELECT * FROM tools WHERE id = ?", id)!));
});

toolsRouter.get("/tools/:id", (req, res) => {
  const tool = getToolChecked(req, req.params.id);
  const members = all(
    "SELECT user_id AS userId, last_active_at AS lastActiveAt FROM tool_members WHERE tool_id = ?",
    tool.id,
  );
  const snapshots = all(
    `SELECT captured_at AS capturedAt, used_amount AS used, limit_amount AS "limit", source
     FROM usage_snapshots WHERE tool_id = ? ORDER BY captured_at ASC`,
    tool.id,
  );
  res.json({ ...serializeTool(tool), members, snapshots });
});

toolsRouter.patch("/tools/:id", (req, res) => {
  const tool = getToolChecked(req, req.params.id, true);
  const body = parseBody(toolSchema.partial(), req.body);
  const merged = {
    name: body.name ?? tool.name,
    slug: body.slug ?? tool.slug,
    category: body.category ?? tool.category,
    icon: body.icon === undefined ? tool.icon : body.icon,
    plan: body.plan ?? tool.plan,
    status: body.status ?? tool.status,
    costCents: body.costCents ?? tool.cost_cents,
    billingCycle: body.billingCycle ?? tool.billing_cycle,
    renewalDate: body.renewalDate ?? tool.renewal_date,
    creditLimit: body.creditLimit === undefined ? tool.credit_limit : body.creditLimit,
    creditUnit: body.creditUnit === undefined ? tool.credit_unit : body.creditUnit,
    usageSource: body.usageSource ?? tool.usage_source,
    note: body.note === undefined ? tool.note : body.note,
  };
  run(
    `UPDATE tools SET name=?, slug=?, category=?, icon=?, plan=?, status=?, cost_cents=?, billing_cycle=?,
       renewal_date=?, credit_limit=?, credit_unit=?, usage_source=?, note=?, updated_at=? WHERE id=?`,
    merged.name,
    merged.slug,
    merged.category,
    merged.icon,
    merged.plan,
    merged.status,
    merged.costCents,
    merged.billingCycle,
    merged.renewalDate,
    merged.creditLimit,
    merged.creditUnit,
    merged.usageSource,
    merged.note,
    now(),
    tool.id,
  );
  if (body.memberIds) setToolMembers(tool.id, tool.workspace_id, body.memberIds);
  res.json(serializeTool(one<ToolRow>("SELECT * FROM tools WHERE id = ?", tool.id)!));
});

toolsRouter.delete("/tools/:id", (req, res) => {
  const tool = getToolChecked(req, req.params.id, true);
  run("DELETE FROM usage_snapshots WHERE tool_id = ?", tool.id);
  run("DELETE FROM tool_members WHERE tool_id = ?", tool.id);
  run("DELETE FROM tools WHERE id = ?", tool.id);
  res.status(204).end();
});

/* ---------- usage ingestion: manual ---------- */

const usageSchema = z.object({
  used: z.number().min(0),
  limit: z.number().positive().nullish(),
  capturedAt: z.string().datetime().optional(),
});

toolsRouter.post("/tools/:id/usage", (req, res) => {
  const tool = getToolChecked(req, req.params.id); // members may report usage
  const body = parseBody(usageSchema, req.body);
  const ts = body.capturedAt ?? now();
  run(
    `INSERT INTO usage_snapshots (id, tool_id, captured_at, used_amount, limit_amount, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`,
    uuid(),
    tool.id,
    ts,
    body.used,
    body.limit ?? tool.credit_limit,
  );
  run("UPDATE tools SET last_usage_update_at = ?, updated_at = ? WHERE id = ?", ts, now(), tool.id);
  // reporting usage also marks the reporter's seat active
  const user = currentUser(req);
  run("UPDATE tool_members SET last_active_at = ? WHERE tool_id = ? AND user_id = ?", ts, tool.id, user.id);
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

toolsRouter.post("/workspaces/:id/tools/import", (req, res) => {
  requireMembership(req, req.params.id, true);
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
    let tool = one<ToolRow>(
      "SELECT * FROM tools WHERE workspace_id = ? AND LOWER(name) = LOWER(?)",
      req.params.id,
      name,
    );
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
      run(
        `INSERT INTO tools (id, workspace_id, name, slug, category, plan, status, cost_cents, billing_cycle,
           renewal_date, credit_limit, credit_unit, usage_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
        id,
        req.params.id,
        name,
        slugify(name),
        category,
        row.plan ?? "",
        ["active", "trial", "cancelled"].includes(row.status) ? row.status : "active",
        costCents,
        cycle,
        renewal,
        row.credit_limit ? Number(row.credit_limit) : null,
        row.credit_unit || null,
        ts,
        ts,
      );
      tool = one<ToolRow>("SELECT * FROM tools WHERE id = ?", id)!;
      results.push({ name, action: "created" });
    }
    if (row.used !== undefined && row.used !== "") {
      const used = Number(row.used);
      if (Number.isFinite(used) && used >= 0) {
        run(
          `INSERT INTO usage_snapshots (id, tool_id, captured_at, used_amount, limit_amount, source)
           VALUES (?, ?, ?, ?, ?, 'csv')`,
          uuid(),
          tool.id,
          ts,
          used,
          tool.credit_limit,
        );
        run("UPDATE tools SET last_usage_update_at = ? WHERE id = ?", ts, tool.id);
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
