// HySav API entrypoint. Serves /api/v1/* plus the static marketing site from
// ../hysav-site, so `npm run dev` gives the whole product on one port.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.ts";
import { all } from "./db.ts";
import { errorHandler } from "./middleware.ts";
import { authRouter } from "./routes/auth.ts";
import { invitesRouter, workspacesRouter } from "./routes/workspaces.ts";
import { toolsRouter } from "./routes/tools.ts";
import { integrationsRouter } from "./routes/integrations.ts";
import { demoRouter, insightsRouter } from "./routes/insights.ts";
import { seedDemoWorkspace } from "./seed.ts";
import { scanWorkspace, sendDigest } from "./services/alerts.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: "text/csv", limit: "1mb" }));

const here = dirname(fileURLToPath(import.meta.url));

const api = express.Router();
api.get("/health", (_req, res) => {
  res.json({ ok: true, version: "v1" });
});
api.get("/openapi.yaml", (_req, res) => {
  res.type("text/yaml").sendFile(join(here, "..", "openapi.yaml"));
});
api.use("/auth", authRouter);
api.use("/workspaces", workspacesRouter);
api.use("/invites", invitesRouter);
api.use("/demo", demoRouter);
api.use(toolsRouter); //        /workspaces/:id/tools, /tools/:id, usage, import
api.use(integrationsRouter); // /workspaces/:id/integrations
api.use(insightsRouter); //     /workspaces/:id/insights, /dashboard, notifications

app.use("/api/v1", api);
app.use(express.static(join(here, "..", "..", "hysav-site")));
app.use(errorHandler);

if (env.seedOnBoot) {
  if (seedDemoWorkspace()) console.log("[seed] demo workspace 'Otterworks Inc.' created");
}

app.listen(env.port, () => {
  console.log(`HySav API + site on http://localhost:${env.port} (docs: /api/v1/openapi.yaml)`);
});

// Background jobs: hourly waste/renewal alert scan, daily digest attempt
// (the digest dedupe key makes it effectively weekly per user). For a
// single-process app a timer beats dragging in a job queue.
const HOUR = 3_600_000;
async function scanAllWorkspaces(): Promise<void> {
  for (const ws of all<{ id: string }>("SELECT id FROM workspaces")) {
    try {
      await scanWorkspace(ws.id, new Date().toISOString());
    } catch (err) {
      console.error(`[jobs] scan failed for workspace ${ws.id}:`, (err as Error).message);
    }
  }
}
async function digestAllWorkspaces(): Promise<void> {
  for (const ws of all<{ id: string }>("SELECT id FROM workspaces")) {
    try {
      await sendDigest(ws.id, new Date().toISOString());
    } catch (err) {
      console.error(`[jobs] digest failed for workspace ${ws.id}:`, (err as Error).message);
    }
  }
}
setInterval(scanAllWorkspaces, HOUR).unref();
setInterval(digestAllWorkspaces, 24 * HOUR).unref();
