CREATE TABLE IF NOT EXISTS theziess_users_v2 (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120),
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Versioned tables avoid conflicts with old Neon schemas that may have
-- missing columns or incompatible ID types.
CREATE TABLE IF NOT EXISTS theziess_subscriptions_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS theziess_free_trials_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS theziess_payments_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  subscription_id TEXT,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
  amount_usd NUMERIC(10, 2) NOT NULL,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  status VARCHAR(20) NOT NULL DEFAULT 'demo_paid',
  transaction_reference VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS theziess_subscriptions_v5_user_status_idx
  ON theziess_subscriptions_v5(user_key, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS theziess_free_trials_v5_user_status_idx
  ON theziess_free_trials_v5(user_key, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS theziess_payments_v5_user_key_idx
  ON theziess_payments_v5(user_key);

-- Server-side activity counters for the admin Telegram bot.
-- Video files are NOT uploaded here; only names, sizes, MIME type and time.
CREATE TABLE IF NOT EXISTS theziess_compression_events_v1 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  input_name VARCHAR(255),
  output_name VARCHAR(255),
  input_bytes BIGINT,
  output_bytes BIGINT,
  output_mime VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS theziess_compression_events_v1_user_created_idx
  ON theziess_compression_events_v1(user_key, created_at DESC);

-- Server-enforced FREE plan quota. One row per user per Cambodia calendar day.
CREATE TABLE IF NOT EXISTS theziess_daily_compression_usage_v1 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  usage_date DATE NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_key, usage_date)
);

CREATE INDEX IF NOT EXISTS theziess_daily_compression_usage_v1_user_date_idx
  ON theziess_daily_compression_usage_v1(user_key, usage_date DESC);

-- TikTok OAuth connections. Tokens are encrypted in application code with
-- AES-256-GCM before they are written to these TEXT columns.
CREATE TABLE IF NOT EXISTS theziess_tiktok_connections_v1 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT UNIQUE NOT NULL,
  open_id TEXT NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  granted_scopes TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upload metadata only. Video binaries are sent directly from the browser to
-- TikTok's short-lived upload URL and are never stored in PostgreSQL.
CREATE TABLE IF NOT EXISTS theziess_tiktok_uploads_v1 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  publish_id VARCHAR(64) UNIQUE NOT NULL,
  filename VARCHAR(255) NOT NULL,
  byte_size BIGINT NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'INITIALIZED',
  tiktok_error_code VARCHAR(120),
  support_log_id VARCHAR(160),
  uploaded_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS theziess_tiktok_uploads_v1_user_created_idx
  ON theziess_tiktok_uploads_v1(user_key, created_at DESC);

CREATE INDEX IF NOT EXISTS theziess_tiktok_uploads_v1_user_status_idx
  ON theziess_tiktok_uploads_v1(user_key, status, updated_at DESC);

-- Single-row website maintenance switch controlled by the admin Telegram bot.
CREATE TABLE IF NOT EXISTS theziess_maintenance_state_v1 (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  message TEXT NOT NULL DEFAULT 'We are improving TheZiess Method. Please check back shortly.',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO theziess_maintenance_state_v1 (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
