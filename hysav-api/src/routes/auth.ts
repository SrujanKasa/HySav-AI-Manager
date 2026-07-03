import { Router } from "express";
import { z } from "zod";
import { generateToken, hashPassword, hashToken, verifyPassword } from "../crypto.ts";
import { all, now, one, run, uuid } from "../db.ts";
import { HttpError, currentUser, parseBody, rateLimit, requireAuth } from "../middleware.ts";

export const authRouter = Router();

const SESSION_DAYS = 30;

// Auth endpoints are the brute-force target — rate limit them hard.
authRouter.use(rateLimit(10, 60_000));

function createSession(userId: string): string {
  const token = generateToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  run(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    uuid(),
    userId,
    hashToken(token),
    expires,
    now(),
  );
  return token;
}

const registerSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(200),
  workspaceName: z.string().min(1).max(120),
});

authRouter.post("/register", (req, res) => {
  const body = parseBody(registerSchema, req.body);
  const email = body.email.toLowerCase();
  if (one("SELECT id FROM users WHERE email = ?", email)) {
    throw new HttpError(409, "An account with this email already exists");
  }
  const userId = uuid();
  const workspaceId = uuid();
  const ts = now();
  run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    userId,
    email,
    body.name,
    hashPassword(body.password),
    ts,
  );
  run("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)", workspaceId, body.workspaceName, ts);
  run(
    "INSERT INTO memberships (user_id, workspace_id, role, initials, color, title, created_at) VALUES (?, ?, 'admin', ?, '#E4570F', 'Admin', ?)",
    userId,
    workspaceId,
    initialsFor(body.name),
    ts,
  );
  res.status(201).json({ token: createSession(userId), user: { id: userId, email, name: body.name }, workspaceId });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

authRouter.post("/login", (req, res) => {
  const body = parseBody(loginSchema, req.body);
  const user = one<{ id: string; email: string; name: string; password_hash: string }>(
    "SELECT id, email, name, password_hash FROM users WHERE email = ?",
    body.email.toLowerCase(),
  );
  // same error for unknown email vs wrong password — no account enumeration
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    throw new HttpError(401, "Invalid email or password");
  }
  res.json({ token: createSession(user.id), user: { id: user.id, email: user.email, name: user.name } });
});

authRouter.post("/logout", requireAuth, (req, res) => {
  const header = req.headers.authorization ?? "";
  run("DELETE FROM sessions WHERE token_hash = ?", hashToken(header.slice(7)));
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = currentUser(req);
  const workspaces = all(
    `SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ?`,
    user.id,
  );
  res.json({ user, workspaces });
});

export function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 2) || "??"
  );
}
