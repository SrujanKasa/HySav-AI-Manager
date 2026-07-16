// The Express app, shared by both runtimes:
//   - src/index.ts   → long-running local/Render server (listen + timers)
//   - api/[...path].ts (repo root) → Vercel serverless function
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.ts";
import { errorHandler } from "./middleware.ts";
import { authRouter } from "./routes/auth.ts";
import { invitesRouter, workspacesRouter } from "./routes/workspaces.ts";
import { toolsRouter } from "./routes/tools.ts";
import { integrationsRouter } from "./routes/integrations.ts";
import { demoRouter, insightsRouter } from "./routes/insights.ts";
import { catalogRouter } from "./routes/catalog.ts";
import { billingRouter, rawBodies, webhookRouter } from "./routes/billing.ts";
import { seedDemoWorkspace, seedTestAccount } from "./seed.ts";

export const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "1mb",
    // keep the raw bytes around for Razorpay webhook HMAC verification
    verify: (req, _res, buf) => {
      rawBodies.set(req as express.Request, buf);
    },
  }),
);
app.use(express.text({ type: "text/csv", limit: "1mb" }));

// Lazy seed: on the first request after a cold start, make sure the demo
// workspace exists (and the dev-only QA account when applicable). Cheap
// after the first call; keeps serverless deploys self-initializing.
let seedPromise: Promise<void> | null = null;
app.use((_req, _res, next) => {
  if (!seedPromise && env.seedOnBoot) {
    seedPromise = (async () => {
      if (await seedDemoWorkspace()) console.log("[seed] demo workspace 'Otterworks Inc.' created");
      await seedTestAccount(); // no-ops in production or without SEED_TEST_USER_PASSWORD
    })().catch((err) => {
      console.error("[seed] failed:", (err as Error).message);
    });
  }
  void (seedPromise ?? Promise.resolve()).then(() => next(), next);
});

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
api.use("/catalog", catalogRouter);
api.use(webhookRouter); //      /billing/webhook (unauthenticated, HMAC-verified)
api.use(billingRouter); //      /workspaces/:id/billing, create-subscription, verify
api.use(toolsRouter); //        /workspaces/:id/tools, /tools/:id, usage, import
api.use(integrationsRouter); // /workspaces/:id/integrations
api.use(insightsRouter); //     /workspaces/:id/insights, /dashboard, notifications

app.use("/api/v1", api);
// Static site for the local single-process setup; on Vercel the static files
// are served by the CDN (cleanUrls maps /join → join.html) and only /api/*
// ever reaches this app. Locally we map the invite link path explicitly.
app.get("/join", (_req, res) => {
  res.sendFile(join(here, "..", "..", "hysav-site", "join.html"));
});
app.use(express.static(join(here, "..", "..", "hysav-site")));
app.use(errorHandler);
