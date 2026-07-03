# hysav-api — HySav | AI Monit backend

Node 22.13+ / TypeScript / Express REST API for tracking AI-tool subscriptions,
monitoring credit burn, and detecting wasted spend. Serves the static marketing
site (`../hysav-site`) too, so one process runs the whole product.

## Run

```bash
npm install
npm run dev        # http://localhost:3000 — site + API, auto-seeds demo data
npm test           # waste-engine tests (vitest)
npm run typecheck
```

No database server needed: uses Node's built-in SQLite (`node:sqlite`), file at
`./data/hysav.db`. Config via env vars — see `.env.example`. A `.env` file in
this folder is picked up automatically.

**Demo login** (seeded): `maya@otterworks.dev` / `otterworks-demo!` — admin of
the "Otterworks Inc." workspace that powers the public demo dashboard.

## Why SQLite (and the Postgres path)

Postgres is the right production default, but this machine has neither
Postgres nor Docker, and a backend that can't run locally can't be verified.
So: `node:sqlite` for zero-infra dev, with the schema (`src/schema.sql`)
written in portable ANSI SQL — TEXT uuids, ISO timestamps, integer cents,
CHECK-constraint enums. Migrating to Neon/Vercel Postgres = swap `src/db.ts`
for a `pg` pool and run the same schema. No model changes.

## Layout

```
src/index.ts            app bootstrap, static site, background jobs
src/schema.sql          full relational schema (portable SQL)
src/db.ts               the only DB touchpoint (node:sqlite)
src/crypto.ts           scrypt passwords, token hashing, AES-256-GCM secrets
src/middleware.ts       bearer auth, rate limiting, zod validation, errors
src/routes/             auth, workspaces+invites+prefs, tools+usage+CSV,
                        integrations, insights+dashboard+demo
src/services/waste.ts   waste-detection engine (pure functions — see tests)
src/services/alerts.ts  alert scanner + weekly digest
src/services/email.ts   outbox + Resend transport (console fallback)
src/providers/          UsageProvider adapters: manual, openai (live),
                        anthropic (live), vercel (stubbed, honestly)
test/waste.test.ts      core-logic tests
openapi.yaml            API contract (also served at /api/v1/openapi.yaml)
```

## Integrations — what's real

| Provider  | Status | How |
|-----------|--------|-----|
| Manual / CSV | ✅ default path | `POST /tools/:id/usage`, `POST /workspaces/:id/tools/import` |
| OpenAI    | ✅ live | org **Costs API** (`/v1/organization/costs`), needs an Admin key |
| Anthropic | ✅ live | Admin API **cost report** (`/v1/organizations/cost_report`) |
| Vercel    | 🔶 stubbed | official usage API exists; sync intentionally unimplemented until verified against a real account |

All of them implement the same `UsageProvider` interface and write to the same
`usage_snapshots` table, so the waste engine never knows whether a number came
from an API or a human.

## Billing (Razorpay-ready)

Pricing: **₹300/month flat, +₹100/month when the team has more than 3 members**
(`src/services/billing.ts`, amounts in paise, computed server-side only).
Endpoints exist and are tested now; they return an honest 503 until you set
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`
(test-mode `rzp_test_...` keys work as-is):

1. `GET  /workspaces/:id/billing` — quote + paid-until status
2. `POST /workspaces/:id/billing/order` — creates the Razorpay order; frontend
   opens Checkout with the returned `orderId` + publishable `keyId`
3. `POST /workspaces/:id/billing/verify` — checkout success handler → HMAC check → plan active
4. `POST /billing/webhook` — server-to-server confirmation, raw-body HMAC verified

## Security notes

- Passwords: scrypt (node:crypto). Sessions: opaque bearer tokens stored as
  sha256 hashes. No cookies ⇒ no CSRF surface.
- Provider API keys: AES-256-GCM under `APP_ENCRYPTION_KEY`, only the last 4
  chars ever leave the server, plaintext never logged.
- Rate limiting on auth + invite-accept endpoints; zod validation on all bodies;
  identical error for unknown-email vs wrong-password.

## Waste rules (src/services/waste.ts)

1. **low_usage** — <5% of credits consumed in the last 30 days (snapshot delta,
   reset-safe) → red, waste ≈ unused share of monthly cost.
2. **expiring_credits** — linear burn forecast lands under 50% at renewal
   (only after 25% of the period has elapsed) → amber.
3. **duplicate** — same category, *disjoint* user sets ("two people separately
   paying for similar tools") → amber; cheaper tool's cost counted once.
4. **forgotten** — active but no usage report in 45+ days → amber signal.
5. **idle_seats** — member inactive 30+ days → their seat-share of cost.
6. **cap_approaching** — projected overrun → info only, never counted as waste.

Per-tool waste is capped at the tool's monthly cost; the workspace headline is
the sum.
