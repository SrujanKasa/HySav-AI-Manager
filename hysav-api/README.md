# hysav-api — HySav | AI Monit backend

Node 22.13+ / TypeScript / Express REST API for tracking AI-tool subscriptions,
monitoring credit burn, and detecting wasted spend. Runs two ways:

- **Local / long-running host**: `npm run dev` serves the API **and** the
  static marketing site (`../hysav-site`) on one port, with background jobs.
- **Vercel serverless**: `api/[...path].ts` at the repo root wraps the same
  Express app; the static site is served by Vercel's CDN alongside it.

## Run

```bash
npm install
npm run dev        # http://localhost:3000 — site + API, auto-seeds demo data
npm test           # waste-engine + billing tests (vitest)
npm run typecheck
```

**Database: MongoDB.** Set `MONGODB_URI` (MongoDB Atlas) in production — it's
required there. Locally, leave it unset and an embedded dev MongoDB
(`mongodb-memory-server`) starts automatically (first boot downloads the
mongod binary), persisted under `./data/mongo`. Config via env vars — see
`.env.example`; a `.env` file in this folder is picked up automatically.

**Demo login** (seeded): `maya@otterworks.dev` / `otterworks-demo!` — admin of
the "Otterworks Inc." workspace that powers the public demo dashboard.

## Collections

`users`, `workspaces`, `memberships`, `invites`, `sessions`, `tools`,
`tool_members`, `usage_snapshots`, `integration_credentials`,
`notification_prefs`, `email_outbox`, `payments` — snake_case fields, `id`
uuid strings, ISO-8601 timestamps, integer cents/paise for money. Unique
indexes on emails, session/invite token hashes, membership pairs, and
Razorpay order/subscription ids (created automatically on connect).

## Layout

```
src/app.ts              the Express app (shared by both runtimes) + lazy seed
src/index.ts            long-running entrypoint: listen + background jobs
../api/[...path].ts     Vercel serverless entrypoint (same app)
src/db.ts               the only DB touchpoint (MongoDB driver / embedded dev mongod)
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

Pricing (`src/services/billing.ts`, amounts in paise, computed server-side only):
**₹300/month up to 3 people, +₹100/month past 3, +₹50/month per person beyond 4**
(4 people ₹400 · 5 ₹450 · 6 ₹500). Every new workspace gets the **Starter plan:
a 3-day full-feature trial** measured from workspace creation — `GET
/workspaces/:id/billing` reports `trial.endsAt` and `active` covers trial or paid.
Endpoints exist and are tested now; they return an honest 503 until you set
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`
(test-mode `rzp_test_...` keys work as-is):

1. `GET  /workspaces/:id/billing` — quote + trial + paid-until status
2. `POST /workspaces/:id/billing/create-subscription` — recurring flow (what the
   pricing page uses): creates a Razorpay Plan + monthly Subscription server-side,
   returns `subscriptionId` + publishable `keyId` for Checkout
3. `POST /workspaces/:id/billing/verify-subscription` — checkout success handler →
   HMAC(payment_id|subscription_id) check → plan active
4. `POST /workspaces/:id/billing/order` / `.../verify` — one-time-order variant
5. `POST /billing/webhook` — server-to-server confirmation (payment.captured,
   order.paid, subscription.charged renewals), raw-body HMAC verified

Frontend: `login.html` / `signup.html` / `account.html` in `hysav-site/` handle
sessions (bearer token in localStorage via `auth.js`); `billing.js` wires
Razorpay Checkout on the pricing + account pages, degrading to the waitlist CTA
when Razorpay isn't configured.

**QA test login (dev-only):** `hynexsbusiness@gmail.com`, password from
`SEED_TEST_USER_PASSWORD` (never hardcoded/committed; account not created if
unset, never created when NODE_ENV=production). Seeded with a 5-person
workspace on a pre-paid top-tier plan (365 days) so the logged-in flow is
testable without running checkout.

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
