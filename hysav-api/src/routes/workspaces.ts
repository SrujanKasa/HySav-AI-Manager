import { Router } from "express";
import { z } from "zod";
import { generateToken, hashPassword, hashToken } from "../crypto.ts";
import { all, now, one, run, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, currentUser, parseBody, rateLimit, requireAuth, requireMembership } from "../middleware.ts";
import { sendEmail } from "../services/email.ts";
import { initialsFor } from "./auth.ts";

export const workspacesRouter = Router();
export const invitesRouter = Router();

workspacesRouter.use(requireAuth);

workspacesRouter.get("/:id", (req, res) => {
  requireMembership(req, req.params.id);
  const ws = one("SELECT id, name, created_at FROM workspaces WHERE id = ?", req.params.id);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const members = all(
    `SELECT u.id, u.email, u.name, m.role, m.initials, m.color, m.title
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?`,
    req.params.id,
  );
  res.json({ ...ws, members });
});

workspacesRouter.patch("/:id", (req, res) => {
  requireMembership(req, req.params.id, true);
  const body = parseBody(z.object({ name: z.string().min(1).max(120) }), req.body);
  run("UPDATE workspaces SET name = ? WHERE id = ?", body.name, req.params.id);
  res.json({ id: req.params.id, name: body.name });
});

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin", "member"]).default("member"),
});

workspacesRouter.post("/:id/invites", (req, res) => {
  requireMembership(req, req.params.id, true);
  const user = currentUser(req);
  const body = parseBody(inviteSchema, req.body);
  const email = body.email.toLowerCase();

  const existing = one(
    `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE u.email = ? AND m.workspace_id = ?`,
    email,
    req.params.id,
  );
  if (existing) throw new HttpError(409, "That person is already in this workspace");

  const token = generateToken();
  const id = uuid();
  run(
    `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    req.params.id,
    email,
    body.role,
    hashToken(token),
    user.id,
    new Date(Date.now() + 7 * 86_400_000).toISOString(),
    now(),
  );

  const ws = one<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", req.params.id);
  const link = `${env.baseUrl}/join?token=${token}`;
  void sendEmail({
    workspaceId: req.params.id,
    to: email,
    kind: "invite",
    subject: `${user.name} invited you to ${ws?.name ?? "a workspace"} on HySav`,
    text: `Join the workspace to see your team's AI subscriptions:\n\n${link}\n\nThis link expires in 7 days.`,
  });

  // The link is also returned so the admin can share it directly (the email
  // transport may be console-only in dev).
  res.status(201).json({ id, email, role: body.role, inviteLink: link, expiresInDays: 7 });
});

// Invite acceptance is unauthenticated (the token IS the credential).
invitesRouter.post("/accept", rateLimit(10, 60_000), (req, res) => {
  const body = parseBody(
    z.object({
      token: z.string().min(10),
      name: z.string().min(1).max(120),
      password: z.string().min(10).max(200),
    }),
    req.body,
  );
  const invite = one<{ id: string; workspace_id: string; email: string; role: "admin" | "member"; expires_at: string; accepted_at: string | null }>(
    "SELECT id, workspace_id, email, role, expires_at, accepted_at FROM invites WHERE token_hash = ?",
    hashToken(body.token),
  );
  if (!invite || invite.accepted_at || invite.expires_at < now()) {
    throw new HttpError(400, "Invite is invalid, expired, or already used");
  }

  let user = one<{ id: string }>("SELECT id FROM users WHERE email = ?", invite.email);
  const ts = now();
  if (!user) {
    const userId = uuid();
    run(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      userId,
      invite.email,
      body.name,
      hashPassword(body.password),
      ts,
    );
    user = { id: userId };
  }
  run(
    `INSERT INTO memberships (user_id, workspace_id, role, initials, color, title, created_at)
     VALUES (?, ?, ?, ?, '#2B7DB8', '', ?)
     ON CONFLICT (user_id, workspace_id) DO NOTHING`,
    user.id,
    invite.workspace_id,
    invite.role,
    initialsFor(body.name),
    ts,
  );
  run("UPDATE invites SET accepted_at = ? WHERE id = ?", ts, invite.id);
  res.status(201).json({ workspaceId: invite.workspace_id, userId: user.id });
});

/* ---------- notification preferences ---------- */

const prefsSchema = z.object({
  wasteAlerts: z.boolean().optional(),
  renewalAlerts: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
});

workspacesRouter.get("/:id/notification-prefs", (req, res) => {
  requireMembership(req, req.params.id);
  const user = currentUser(req);
  const p = one<{ waste_alerts: number; renewal_alerts: number; weekly_digest: number }>(
    "SELECT waste_alerts, renewal_alerts, weekly_digest FROM notification_prefs WHERE user_id = ? AND workspace_id = ?",
    user.id,
    req.params.id,
  );
  res.json({
    wasteAlerts: p ? !!p.waste_alerts : true,
    renewalAlerts: p ? !!p.renewal_alerts : true,
    weeklyDigest: p ? !!p.weekly_digest : true,
  });
});

workspacesRouter.patch("/:id/notification-prefs", (req, res) => {
  requireMembership(req, req.params.id);
  const user = currentUser(req);
  const body = parseBody(prefsSchema, req.body);
  const current = one<{ waste_alerts: number; renewal_alerts: number; weekly_digest: number }>(
    "SELECT waste_alerts, renewal_alerts, weekly_digest FROM notification_prefs WHERE user_id = ? AND workspace_id = ?",
    user.id,
    req.params.id,
  );
  const next = {
    waste: body.wasteAlerts ?? (current ? !!current.waste_alerts : true),
    renewal: body.renewalAlerts ?? (current ? !!current.renewal_alerts : true),
    digest: body.weeklyDigest ?? (current ? !!current.weekly_digest : true),
  };
  run(
    `INSERT INTO notification_prefs (user_id, workspace_id, waste_alerts, renewal_alerts, weekly_digest)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, workspace_id) DO UPDATE SET waste_alerts = excluded.waste_alerts,
       renewal_alerts = excluded.renewal_alerts, weekly_digest = excluded.weekly_digest`,
    user.id,
    req.params.id,
    next.waste ? 1 : 0,
    next.renewal ? 1 : 0,
    next.digest ? 1 : 0,
  );
  res.json({ wasteAlerts: next.waste, renewalAlerts: next.renewal, weeklyDigest: next.digest });
});
