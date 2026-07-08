// Auth, rate limiting, validation, and error plumbing.
//
// Auth model: opaque bearer tokens (Authorization: Bearer <token>), stored
// hashed in `sessions`. No cookies are used, so CSRF does not apply — a
// cross-site request can't attach the token. If this ever moves to cookie
// sessions, add SameSite=Lax + a CSRF token then.
import type { NextFunction, Request, Response } from "express";
import type { TypeOf, ZodType } from "zod";
import { hashToken } from "./crypto.ts";
import { now, one } from "./db.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

// Express 5 types don't thread custom props; keep a WeakMap instead of
// mutating req so `strict` stays honest.
const authedUsers = new WeakMap<Request, AuthedUser>();

export function currentUser(req: Request): AuthedUser {
  const u = authedUsers.get(req);
  if (!u) throw new HttpError(401, "Authentication required");
  return u;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Authentication required");
  const session = await one<{ user_id: string; expires_at: string }>("sessions", { token_hash: hashToken(token) });
  if (!session || session.expires_at < now()) throw new HttpError(401, "Session expired or invalid");
  const user = await one<AuthedUser & { password_hash?: string }>("users", { id: session.user_id });
  if (!user) throw new HttpError(401, "Session expired or invalid");
  authedUsers.set(req, { id: user.id, email: user.email, name: user.name });
  next();
}

/** Asserts membership (optionally admin) and returns the role. */
export async function requireMembership(
  req: Request,
  workspaceId: string,
  adminOnly = false,
): Promise<"admin" | "member"> {
  const user = currentUser(req);
  const m = await one<{ role: "admin" | "member" }>("memberships", { user_id: user.id, workspace_id: workspaceId });
  if (!m) throw new HttpError(404, "Workspace not found");
  if (adminOnly && m.role !== "admin") throw new HttpError(403, "Admin role required");
  return m.role;
}

/** Simple in-memory sliding-window rate limiter (per IP + route group).
 *  Fine for a single-process deployment; swap for Redis if this ever scales out. */
export function rateLimit(maxHits: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = `${req.ip}:${req.baseUrl}`;
    const cutoff = Date.now() - windowMs;
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= maxHits) throw new HttpError(429, "Too many requests — slow down");
    list.push(Date.now());
    hits.set(key, list);
    next();
  };
}

/** Zod-validated request body. */
export function parseBody<S extends ZodType>(schema: S, body: unknown): TypeOf<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, `Invalid request: ${detail}`);
  }
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Deploy-time misconfiguration deserves an honest answer, not a mystery 500.
  if (err instanceof Error && err.message.includes("MONGODB_URI is required")) {
    res.status(503).json({
      error: "Database not connected yet — set MONGODB_URI (MongoDB Atlas connection string) in the server environment",
    });
    return;
  }
  // Never leak internals (or anything that could contain a credential).
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}
