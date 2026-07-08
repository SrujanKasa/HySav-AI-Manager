import { Router } from "express";
import { z } from "zod";
import { generateToken, hashPassword, hashToken } from "../crypto.ts";
import { all, insert, insertIgnoreDup, now, one, update, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, currentUser, parseBody, rateLimit, requireAuth, requireMembership } from "../middleware.ts";
import { sendEmail } from "../services/email.ts";
import { initialsFor } from "./auth.ts";

export const workspacesRouter = Router();
export const invitesRouter = Router();

workspacesRouter.use(requireAuth);

workspacesRouter.get("/:id", async (req, res) => {
  await requireMembership(req, req.params.id);
  const ws = await one<{ id: string; name: string; created_at: string }>("workspaces", { id: req.params.id });
  if (!ws) throw new HttpError(404, "Workspace not found");
  const memberships = await all<{ user_id: string; role: string; initials: string; color: string; title: string }>(
    "memberships",
    { workspace_id: req.params.id },
  );
  const users = await all<{ id: string; email: string; name: string }>("users", {
    id: { $in: memberships.map((m) => m.user_id) },
  });
  const members = memberships.map((m) => {
    const u = users.find((x) => x.id === m.user_id);
    return {
      id: m.user_id,
      email: u?.email ?? "",
      name: u?.name ?? "",
      role: m.role,
      initials: m.initials,
      color: m.color,
      title: m.title,
    };
  });
  res.json({ ...ws, members });
});

workspacesRouter.patch("/:id", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  const body = parseBody(z.object({ name: z.string().min(1).max(120) }), req.body);
  await update("workspaces", { id: req.params.id }, { name: body.name });
  res.json({ id: req.params.id, name: body.name });
});

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin", "member"]).default("member"),
});

workspacesRouter.post("/:id/invites", async (req, res) => {
  await requireMembership(req, req.params.id, true);
  const user = currentUser(req);
  const body = parseBody(inviteSchema, req.body);
  const email = body.email.toLowerCase();

  const invited = await one<{ id: string }>("users", { email });
  if (invited && (await one("memberships", { user_id: invited.id, workspace_id: req.params.id }))) {
    throw new HttpError(409, "That person is already in this workspace");
  }

  const token = generateToken();
  const id = uuid();
  await insert("invites", {
    id,
    workspace_id: req.params.id,
    email,
    role: body.role,
    token_hash: hashToken(token),
    invited_by: user.id,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    accepted_at: null,
    created_at: now(),
  });

  const ws = await one<{ name: string }>("workspaces", { id: req.params.id });
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
invitesRouter.post("/accept", rateLimit(10, 60_000), async (req, res) => {
  const body = parseBody(
    z.object({
      token: z.string().min(10),
      name: z.string().min(1).max(120),
      password: z.string().min(10).max(200),
    }),
    req.body,
  );
  const invite = await one<{
    id: string;
    workspace_id: string;
    email: string;
    role: "admin" | "member";
    expires_at: string;
    accepted_at: string | null;
  }>("invites", { token_hash: hashToken(body.token) });
  if (!invite || invite.accepted_at || invite.expires_at < now()) {
    throw new HttpError(400, "Invite is invalid, expired, or already used");
  }

  let user = await one<{ id: string }>("users", { email: invite.email });
  const ts = now();
  if (!user) {
    const userId = uuid();
    await insert("users", {
      id: userId,
      email: invite.email,
      name: body.name,
      password_hash: hashPassword(body.password),
      created_at: ts,
    });
    user = { id: userId };
  }
  await insertIgnoreDup("memberships", {
    user_id: user.id,
    workspace_id: invite.workspace_id,
    role: invite.role,
    initials: initialsFor(body.name),
    color: "#2B7DB8",
    title: "",
    created_at: ts,
  });
  await update("invites", { id: invite.id }, { accepted_at: ts });
  res.status(201).json({ workspaceId: invite.workspace_id, userId: user.id });
});

/* ---------- notification preferences ---------- */

const prefsSchema = z.object({
  wasteAlerts: z.boolean().optional(),
  renewalAlerts: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
});

workspacesRouter.get("/:id/notification-prefs", async (req, res) => {
  await requireMembership(req, req.params.id);
  const user = currentUser(req);
  const p = await one<{ waste_alerts: number; renewal_alerts: number; weekly_digest: number }>("notification_prefs", {
    user_id: user.id,
    workspace_id: req.params.id,
  });
  res.json({
    wasteAlerts: p ? !!p.waste_alerts : true,
    renewalAlerts: p ? !!p.renewal_alerts : true,
    weeklyDigest: p ? !!p.weekly_digest : true,
  });
});

workspacesRouter.patch("/:id/notification-prefs", async (req, res) => {
  await requireMembership(req, req.params.id);
  const user = currentUser(req);
  const body = parseBody(prefsSchema, req.body);
  const current = await one<{ waste_alerts: number; renewal_alerts: number; weekly_digest: number }>(
    "notification_prefs",
    { user_id: user.id, workspace_id: req.params.id },
  );
  const next = {
    waste: body.wasteAlerts ?? (current ? !!current.waste_alerts : true),
    renewal: body.renewalAlerts ?? (current ? !!current.renewal_alerts : true),
    digest: body.weeklyDigest ?? (current ? !!current.weekly_digest : true),
  };
  await update(
    "notification_prefs",
    { user_id: user.id, workspace_id: req.params.id },
    {
      user_id: user.id,
      workspace_id: req.params.id,
      waste_alerts: next.waste ? 1 : 0,
      renewal_alerts: next.renewal ? 1 : 0,
      weekly_digest: next.digest ? 1 : 0,
    },
    true, // upsert
  );
  res.json({ wasteAlerts: next.waste, renewalAlerts: next.renewal, weeklyDigest: next.digest });
});
