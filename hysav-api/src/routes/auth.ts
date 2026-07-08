import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { generateToken, hashPassword, hashToken, verifyPassword } from "../crypto.ts";
import { all, now, one, run, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, currentUser, parseBody, rateLimit, requireAuth } from "../middleware.ts";

export const authRouter = Router();

const SESSION_DAYS = 30;

// Credential endpoints are the brute-force target — rate limit those hard.
// /me and /logout are NOT limited: every page load calls /me, and throttling
// it signs users out for browsing too fast.
const credentialLimiter = rateLimit(10, 60_000);

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

authRouter.post("/register", credentialLimiter, (req, res) => {
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

authRouter.post("/login", credentialLimiter, (req, res) => {
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

/* ---------- Google OAuth (authorization-code flow) ----------
   GET /auth/google           → 302 to Google's consent screen
   GET /auth/google/callback  → code exchange server-side (client_secret never
                                leaves the backend), find-or-create the user,
                                then redirect to /account.html#token=...
   GET /auth/methods          → which login methods are configured (the login
                                page hides the Google button when false) */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// short-lived anti-CSRF state tokens for the OAuth round-trip
const oauthStates = new Map<string, number>();

function googleRedirectUri(): string {
  return `${env.baseUrl}/api/v1/auth/google/callback`;
}

authRouter.get("/methods", (_req, res) => {
  res.json({ password: true, google: !!(env.googleClientId && env.googleClientSecret) });
});

authRouter.get("/google", (_req, res) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new HttpError(503, "Google login is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }
  const state = generateToken();
  oauthStates.set(state, Date.now() + 10 * 60_000);
  for (const [s, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(s);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

authRouter.get("/google/callback", async (req, res) => {
  const fail = (reason: string): void => {
    console.error(`[auth] google oauth failed: ${reason}`);
    res.redirect("/login.html#error=google");
  };
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state || !oauthStates.has(state) || oauthStates.get(state)! < Date.now()) {
    return fail("missing or expired code/state");
  }
  oauthStates.delete(state);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail(`token exchange returned ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("no id_token in response");

  // The id_token came straight from Google over TLS, so decoding its payload
  // without re-verifying the signature is safe here.
  let profile: { email?: string; email_verified?: boolean; name?: string };
  try {
    profile = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return fail("unparseable id_token");
  }
  if (!profile.email || profile.email_verified === false) return fail("no verified email");

  const email = profile.email.toLowerCase();
  const displayName = profile.name || email.split("@")[0];
  let user = one<{ id: string }>("SELECT id FROM users WHERE email = ?", email);
  const ts = now();
  if (!user) {
    // first Google sign-in: create the account + a workspace, same shape as
    // /register. Password is a random unusable hash — Google is their login.
    const userId = uuid();
    const workspaceId = uuid();
    run(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      userId, email, displayName, hashPassword(randomUUID()), ts,
    );
    run(
      "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
      workspaceId, `${displayName.split(" ")[0]}'s team`, ts,
    );
    run(
      "INSERT INTO memberships (user_id, workspace_id, role, initials, color, title, created_at) VALUES (?, ?, 'admin', ?, '#E4570F', 'Admin', ?)",
      userId, workspaceId, initialsFor(displayName), ts,
    );
    user = { id: userId };
  }
  // token travels in the URL fragment (never sent to any server) and the
  // account page moves it to localStorage immediately
  res.redirect(`/account.html#token=${createSession(user.id)}`);
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
