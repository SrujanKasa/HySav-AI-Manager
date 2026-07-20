import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { generateToken, hashPassword, hashToken, verifyPassword } from "../crypto.ts";
import { all, insert, now, one, remove, uuid } from "../db.ts";
import { env } from "../env.ts";
import { HttpError, currentUser, parseBody, rateLimit, requireAuth } from "../middleware.ts";

export const authRouter = Router();

const SESSION_DAYS = 30;

// Credential endpoints are the brute-force target — rate limit those hard.
// /me and /logout are NOT limited: every page load calls /me, and throttling
// it signs users out for browsing too fast.
const credentialLimiter = rateLimit(10, 60_000);

async function createSession(userId: string): Promise<string> {
  const token = generateToken();
  await insert("sessions", {
    id: uuid(),
    user_id: userId,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
    created_at: now(),
  });
  return token;
}

const registerSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(200),
  workspaceName: z.string().min(1).max(120),
});

authRouter.post("/register", credentialLimiter, async (req, res) => {
  const body = parseBody(registerSchema, req.body);
  const email = body.email.toLowerCase();
  if (await one("users", { email })) {
    throw new HttpError(409, "An account with this email already exists");
  }
  const userId = uuid();
  const workspaceId = uuid();
  const ts = now();
  await insert("users", { id: userId, email, name: body.name, password_hash: hashPassword(body.password), created_at: ts });
  await insert("workspaces", { id: workspaceId, name: body.workspaceName, created_at: ts });
  await insert("memberships", {
    user_id: userId,
    workspace_id: workspaceId,
    role: "admin",
    initials: initialsFor(body.name),
    color: "#E4570F",
    title: "Admin",
    created_at: ts,
  });
  res.status(201).json({ token: await createSession(userId), user: { id: userId, email, name: body.name }, workspaceId });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

authRouter.post("/login", credentialLimiter, async (req, res) => {
  const body = parseBody(loginSchema, req.body);
  const user = await one<{ id: string; email: string; name: string; password_hash: string }>("users", {
    email: body.email.toLowerCase(),
  });
  // same error for unknown email vs wrong password — no account enumeration
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    throw new HttpError(401, "Invalid email or password");
  }
  res.json({ token: await createSession(user.id), user: { id: user.id, email: user.email, name: user.name } });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  const header = req.headers.authorization ?? "";
  await remove("sessions", { token_hash: hashToken(header.slice(7)) });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = currentUser(req);
  const memberships = await all<{ workspace_id: string; role: string }>("memberships", { user_id: user.id });
  const workspaces = await all<{ id: string; name: string }>("workspaces", {
    id: { $in: memberships.map((m) => m.workspace_id) },
  });
  res.json({
    user,
    workspaces: memberships
      .map((m) => {
        const ws = workspaces.find((w) => w.id === m.workspace_id);
        return ws ? { id: ws.id, name: ws.name, role: m.role } : null;
      })
      .filter((x) => x !== null),
  });
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

function issueOauthState(): string {
  const state = generateToken();
  oauthStates.set(state, Date.now() + 10 * 60_000);
  for (const [s, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(s);
  return state;
}

function consumeOauthState(state: string | null): boolean {
  if (!state || !oauthStates.has(state) || oauthStates.get(state)! < Date.now()) return false;
  oauthStates.delete(state);
  return true;
}

/** Shared by every social login: find the account by verified email or create
 *  it (+ a workspace, same shape as /register) with an unusable random
 *  password — the social provider is their login. */
async function findOrCreateOauthUser(email: string, displayName: string): Promise<string> {
  const existing = await one<{ id: string }>("users", { email });
  if (existing) return existing.id;
  const ts = now();
  const userId = uuid();
  const workspaceId = uuid();
  await insert("users", { id: userId, email, name: displayName, password_hash: hashPassword(randomUUID()), created_at: ts });
  await insert("workspaces", { id: workspaceId, name: `${displayName.split(" ")[0]}'s team`, created_at: ts });
  await insert("memberships", {
    user_id: userId,
    workspace_id: workspaceId,
    role: "admin",
    initials: initialsFor(displayName),
    color: "#E4570F",
    title: "Admin",
    created_at: ts,
  });
  return userId;
}

function googleRedirectUri(): string {
  return `${env.baseUrl}/api/v1/auth/google/callback`;
}

authRouter.get("/methods", (_req, res) => {
  res.json({
    password: true,
    google: !!(env.googleClientId && env.googleClientSecret),
    github: !!(env.githubClientId && env.githubClientSecret),
  });
});

authRouter.get("/google", (_req, res) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new HttpError(503, "Google login is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }
  const state = issueOauthState();
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
  if (!code || !consumeOauthState(state)) {
    return fail("missing or expired code/state");
  }

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
  const userId = await findOrCreateOauthUser(email, profile.name || email.split("@")[0]);
  // token travels in the URL fragment (never sent to any server) and the
  // dashboard moves it to localStorage immediately
  res.redirect(`/dashboard.html#token=${await createSession(userId)}`);
});

/* ---------- GitHub OAuth (same pattern) ---------- */

function githubRedirectUri(): string {
  return `${env.baseUrl}/api/v1/auth/github/callback`;
}

authRouter.get("/github", (_req, res) => {
  if (!env.githubClientId || !env.githubClientSecret) {
    throw new HttpError(503, "GitHub login is not configured — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET");
  }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.githubClientId);
  url.searchParams.set("redirect_uri", githubRedirectUri());
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", issueOauthState());
  res.redirect(url.toString());
});

authRouter.get("/github/callback", async (req, res) => {
  const fail = (reason: string): void => {
    console.error(`[auth] github oauth failed: ${reason}`);
    res.redirect("/login.html#error=github");
  };
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !consumeOauthState(state)) return fail("missing or expired code/state");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: env.githubClientId!,
      client_secret: env.githubClientSecret!,
      redirect_uri: githubRedirectUri(),
    }),
  });
  if (!tokenRes.ok) return fail(`token exchange returned ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return fail("no access_token in response");

  const ghHeaders = { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "HySav" };
  const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
  if (!userRes.ok) return fail(`user API returned ${userRes.status}`);
  const gh = (await userRes.json()) as { name?: string; login?: string; email?: string | null };

  // the profile email is often null — the /user/emails endpoint has the
  // verified primary address
  let email = gh.email;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", { headers: ghHeaders });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }
  if (!email) return fail("no verified email on the GitHub account");

  const userId = await findOrCreateOauthUser(email.toLowerCase(), gh.name || gh.login || email.split("@")[0]);
  res.redirect(`/dashboard.html#token=${await createSession(userId)}`);
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
