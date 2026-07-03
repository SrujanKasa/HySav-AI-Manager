-- HySav schema.
-- Written for SQLite (node:sqlite) but kept ANSI-portable: TEXT ids (uuid),
-- ISO-8601 timestamps as TEXT, integer cents for money, CHECK-constrained
-- enums instead of engine-specific types. Porting to Postgres means swapping
-- TEXT timestamps for timestamptz and adding proper FK indexes — nothing
-- structural.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- role: 'admin' can manage tools/members/integrations, 'member' can view and
-- be assigned to tools. The workspace creator is always an admin.
CREATE TABLE IF NOT EXISTS memberships (
  user_id      TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  -- short display key for avatars ("MK") — demo/dashboard convenience
  initials     TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#5D574B',
  title        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256 of the invite token; raw token only in the invite link
  invited_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the bearer token
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per AI-tool subscription in a workspace.
CREATE TABLE IF NOT EXISTS tools (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,            -- stable key, also picks the logo asset
  category             TEXT NOT NULL,            -- 'llm-chat' | 'coding-assistant' | 'image-gen' | 'video-gen' | 'copywriting' | 'voice' | 'productivity' | 'search' | 'presentation' | 'other'
  icon                 TEXT,                     -- optional explicit icon URL; falls back to slug asset
  plan                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL CHECK (status IN ('active', 'trial', 'cancelled')) DEFAULT 'active',
  cost_cents           INTEGER NOT NULL,
  billing_cycle        TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')) DEFAULT 'monthly',
  renewal_date         TEXT NOT NULL,            -- next renewal, ISO date
  credit_limit         REAL,                     -- usage cap per billing period, NULL if the tool has none
  credit_unit          TEXT,                     -- 'messages', 'GPU hours', 'credits', ...
  usage_source         TEXT NOT NULL CHECK (usage_source IN ('manual', 'openai', 'anthropic', 'vercel')) DEFAULT 'manual',
  note                 TEXT,                     -- freeform; dashboard falls back to a generated summary
  last_usage_update_at TEXT,                     -- when usage was last reported (manual or sync) — feeds "forgotten tool" detection
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_workspace ON tools(workspace_id);

-- Which members use/own a tool. last_active_at is self-reported or synced;
-- a NULL or old value marks the seat idle.
CREATE TABLE IF NOT EXISTS tool_members (
  tool_id        TEXT NOT NULL REFERENCES tools(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  is_owner       INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT,
  PRIMARY KEY (tool_id, user_id)
);

-- Historical usage snapshots — the dashboard trend data. One row each time
-- usage is reported (manual entry, CSV import, or provider sync).
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id           TEXT PRIMARY KEY,
  tool_id      TEXT NOT NULL REFERENCES tools(id),
  captured_at  TEXT NOT NULL,
  used_amount  REAL NOT NULL,             -- cumulative usage within the current billing period
  limit_amount REAL,                      -- cap at capture time (may change on plan changes)
  source       TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'openai', 'anthropic', 'vercel')) DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_tool_time ON usage_snapshots(tool_id, captured_at);

-- Encrypted third-party credentials for live usage integrations.
-- key_ciphertext is AES-256-GCM (iv:tag:data, base64) under APP_ENCRYPTION_KEY.
-- Only key_last4 is ever returned to clients; plaintext is never logged.
CREATE TABLE IF NOT EXISTS integration_credentials (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider     TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'vercel')),
  key_ciphertext TEXT NOT NULL,
  key_last4    TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  waste_alerts  INTEGER NOT NULL DEFAULT 1,
  renewal_alerts INTEGER NOT NULL DEFAULT 1,
  weekly_digest INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, workspace_id)
);

-- Razorpay billing. Amounts in paise (INR). A workspace is "paid" when its
-- latest paid row's period_end is in the future — no plan column to migrate.
CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  razorpay_order_id   TEXT UNIQUE,
  razorpay_payment_id TEXT,
  amount_paise        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL CHECK (status IN ('created', 'paid', 'failed')) DEFAULT 'created',
  period_start        TEXT,
  period_end          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_workspace ON payments(workspace_id, status);

-- Outbox pattern: every email is recorded here; the transport marks it sent
-- (Resend) or logged (no provider configured). Nothing secret goes in bodies.
CREATE TABLE IF NOT EXISTS email_outbox (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  to_email     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- 'waste_alert' | 'renewal_alert' | 'digest' | 'invite'
  status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'logged', 'failed')) DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  sent_at      TEXT,
  -- dedupe key so the alert scanner doesn't re-send the same alert every run
  dedupe_key   TEXT UNIQUE
);
