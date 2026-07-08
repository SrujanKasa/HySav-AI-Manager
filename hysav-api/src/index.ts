// Long-running server entrypoint (local dev / Render / any VM):
// serves the app + runs the background jobs. The Vercel serverless entry
// (api/[...path].ts at the repo root) imports the same app without this file.
import { app } from "./app.ts";
import { env } from "./env.ts";
import { all } from "./db.ts";
import { scanWorkspace, sendDigest } from "./services/alerts.ts";

app.listen(env.port, () => {
  console.log(`HySav API + site on http://localhost:${env.port} (docs: /api/v1/openapi.yaml)`);
});

// Background jobs: hourly waste/renewal alert scan, daily digest attempt
// (the digest dedupe key makes it effectively weekly per user). For a
// single-process app a timer beats dragging in a job queue. On Vercel these
// don't run — use Vercel Cron hitting the /notifications endpoints instead.
const HOUR = 3_600_000;
async function scanAllWorkspaces(): Promise<void> {
  for (const ws of await all<{ id: string }>("workspaces", {})) {
    try {
      await scanWorkspace(ws.id, new Date().toISOString());
    } catch (err) {
      console.error(`[jobs] scan failed for workspace ${ws.id}:`, (err as Error).message);
    }
  }
}
async function digestAllWorkspaces(): Promise<void> {
  for (const ws of await all<{ id: string }>("workspaces", {})) {
    try {
      await sendDigest(ws.id, new Date().toISOString());
    } catch (err) {
      console.error(`[jobs] digest failed for workspace ${ws.id}:`, (err as Error).message);
    }
  }
}
setInterval(scanAllWorkspaces, HOUR).unref();
setInterval(digestAllWorkspaces, 24 * HOUR).unref();
