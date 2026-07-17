// Scheduled-jobs endpoint for serverless deployments. Vercel Cron calls
// GET /api/v1/jobs/daily (schedule in vercel.json) with
// "Authorization: Bearer <CRON_SECRET>" — Vercel attaches that header
// automatically when the CRON_SECRET env var exists. The same work runs
// hourly via setInterval on the long-running local server (src/index.ts).
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { all } from "../db.ts";
import { HttpError } from "../middleware.ts";
import { scanWorkspace, sendDigest } from "../services/alerts.ts";
import { syncEverything } from "../services/sync.ts";

export const jobsRouter = Router();

function checkCronAuth(header: string | undefined): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(503, "CRON_SECRET not configured");
  const expected = `Bearer ${secret}`;
  const got = header ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Bad cron credentials");
}

jobsRouter.get("/daily", async (req, res) => {
  checkCronAuth(req.headers.authorization);
  const sync = await syncEverything();
  let scans = 0;
  let digests = 0;
  for (const ws of await all<{ id: string }>("workspaces", {})) {
    try {
      await scanWorkspace(ws.id, new Date().toISOString());
      scans++;
      await sendDigest(ws.id, new Date().toISOString()); // dedupe key makes this weekly per user
      digests++;
    } catch (err) {
      console.error(`[jobs] daily run failed for workspace ${ws.id}:`, (err as Error).message);
    }
  }
  res.json({ ok: true, sync, scans, digests });
});
