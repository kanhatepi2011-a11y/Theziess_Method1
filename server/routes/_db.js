import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing.");
}

const globalDatabase = globalThis;

export const pool =
  globalDatabase.__theziessPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalDatabase.__theziessPool = pool;
}

export function getPool() {
  return pool;
}

const USERS_TABLE = "theziess_users_v2";
const SUBSCRIPTIONS_TABLE = "theziess_subscriptions_v5";
const FREE_TRIALS_TABLE = "theziess_free_trials_v5";
const PAYMENTS_TABLE = "theziess_payments_v5";
const COMPRESSION_EVENTS_TABLE = "theziess_compression_events_v1";
const DAILY_COMPRESSION_USAGE_TABLE = "theziess_daily_compression_usage_v1";
const TIKTOK_CONNECTIONS_TABLE = "theziess_tiktok_connections_v1";
const TIKTOK_UPLOADS_TABLE = "theziess_tiktok_uploads_v1";

let schemaPromise;
let userMigrationPromise;
let paidPlanMigrationPromise;

/**
 * Copy legacy users into the versioned table when possible. The old `users`
 * table may define telegram_id as INTEGER, which overflows for newer Telegram
 * account IDs and raises PostgreSQL 22003 during login. The new table stores
 * Telegram IDs as TEXT so every valid Telegram ID is accepted safely.
 *
 * Migration is best-effort and never blocks authentication. Existing numeric
 * user IDs are preserved when the legacy schema is compatible, keeping old
 * subscription user_key values connected to the same account.
 */
async function migrateLegacyUsersSafely() {
  if (!userMigrationPromise) {
    userMigrationPromise = (async () => {
      const legacy = await pool.query(
        "SELECT to_regclass('public.users') AS legacy_users",
      );

      if (!legacy.rows[0]?.legacy_users) return false;

      await pool.query(`
        INSERT INTO ${USERS_TABLE} (
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          photo_url,
          created_at,
          updated_at,
          last_login_at
        )
        SELECT
          legacy_user.id::BIGINT,
          legacy_user.telegram_id::TEXT,
          NULLIF(to_jsonb(legacy_user)->>'username', ''),
          COALESCE(
            NULLIF(to_jsonb(legacy_user)->>'first_name', ''),
            'Telegram User'
          ),
          NULLIF(to_jsonb(legacy_user)->>'last_name', ''),
          NULLIF(to_jsonb(legacy_user)->>'photo_url', ''),
          NOW(),
          NOW(),
          NOW()
        FROM users AS legacy_user
        WHERE legacy_user.telegram_id IS NOT NULL
        ON CONFLICT DO NOTHING
      `);

      await pool.query(`
        SELECT setval(
          pg_get_serial_sequence('${USERS_TABLE}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${USERS_TABLE}), 1),
          EXISTS(SELECT 1 FROM ${USERS_TABLE})
        )
      `);

      return true;
    })().catch((error) => {
      console.warn("Legacy user migration skipped:", {
        code: error?.code || "UNKNOWN",
        message: error?.message || String(error),
      });
      return false;
    });
  }

  return userMigrationPromise;
}

/**
 * Upgrade old paid subscriptions without making login depend on a DDL change.
 * Some hosted PostgreSQL roles can read/write tables but cannot ALTER them.
 * V12 ran ALTER TABLE during every cold start, so one permission/lock/data
 * problem prevented upsertTelegramUser() and made Telegram login fail.
 *
 * New grants already have the correct expiry. This migration is best-effort:
 * it upgrades old rows, logs a failure, and never blocks authentication.
 */
async function migratePaidPlanDurationsSafely() {
  if (!paidPlanMigrationPromise) {
    paidPlanMigrationPromise = (async () => {
      await pool.query(`
        UPDATE ${SUBSCRIPTIONS_TABLE}
        SET
          expires_at = CASE
            WHEN plan_id = 'pro' THEN starts_at + INTERVAL '30 days'
            WHEN plan_id = 'premium' THEN starts_at + INTERVAL '180 days'
            WHEN plan_id = 'max' THEN starts_at + INTERVAL '365 days'
            ELSE expires_at
          END,
          updated_at = NOW()
        WHERE
          (plan_id = 'pro' AND expires_at IS NULL)
          OR (
            plan_id = 'premium'
            AND (
              expires_at IS NULL
              OR expires_at < starts_at + INTERVAL '180 days'
            )
          )
          OR (plan_id = 'max' AND expires_at IS NULL)
      `);

      return true;
    })().catch((error) => {
      // Authentication must continue even if legacy subscription data cannot
      // be migrated during this request. Admin can re-grant the plan later.
      console.error("Paid plan duration migration skipped:", {
        code: error?.code || "UNKNOWN",
        message: error?.message || String(error),
      });
      return false;
    });
  }

  return paidPlanMigrationPromise;
}

/**
 * Versioned subscription tables deliberately avoid old Neon tables whose
 * columns/types may differ. PostgreSQL 42703 means an old table is missing a
 * column referenced by the application. Using new versioned tables makes the
 * migration deterministic and does not delete or alter existing data.
 */
export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          telegram_id TEXT UNIQUE NOT NULL,
          username VARCHAR(100),
          first_name VARCHAR(120) NOT NULL,
          last_name VARCHAR(120),
          photo_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SUBSCRIPTIONS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${FREE_TRIALS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT UNIQUE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${PAYMENTS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          subscription_id TEXT,
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          amount_usd NUMERIC(10, 2) NOT NULL,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          status VARCHAR(20) NOT NULL DEFAULT 'demo_paid',
          transaction_reference VARCHAR(120) UNIQUE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${COMPRESSION_EVENTS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          input_name VARCHAR(255),
          output_name VARCHAR(255),
          input_bytes BIGINT,
          output_bytes BIGINT,
          output_mime VARCHAR(120),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${DAILY_COMPRESSION_USAGE_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          usage_date DATE NOT NULL,
          usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_key, usage_date)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TIKTOK_CONNECTIONS_TABLE} (
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
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TIKTOK_UPLOADS_TABLE} (
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
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_subscriptions_v5_user_status_idx
          ON ${SUBSCRIPTIONS_TABLE}(user_key, status, expires_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_free_trials_v5_user_status_idx
          ON ${FREE_TRIALS_TABLE}(user_key, status, expires_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_payments_v5_user_key_idx
          ON ${PAYMENTS_TABLE}(user_key)
      `);


      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_compression_events_v1_user_created_idx
          ON ${COMPRESSION_EVENTS_TABLE}(user_key, created_at DESC)
      `);


      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_daily_compression_usage_v1_user_date_idx
          ON ${DAILY_COMPRESSION_USAGE_TABLE}(user_key, usage_date DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_tiktok_uploads_v1_user_created_idx
          ON ${TIKTOK_UPLOADS_TABLE}(user_key, created_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_tiktok_uploads_v1_user_status_idx
          ON ${TIKTOK_UPLOADS_TABLE}(user_key, status, updated_at DESC)
      `);


      // Preserve compatible legacy accounts, but never let migration block login.
      await migrateLegacyUsersSafely();

      // Never let a legacy paid-plan migration prevent Telegram login.
      await migratePaidPlanDurationsSafely();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  return schemaPromise;
}

export async function upsertTelegramUser(telegramUser) {
  await ensureSchema();

  const result = await pool.query(
    `
      INSERT INTO ${USERS_TABLE} (
        telegram_id,
        username,
        first_name,
        last_name,
        photo_url,
        last_login_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        photo_url = EXCLUDED.photo_url,
        last_login_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `,
    [
      String(telegramUser.id),
      telegramUser.username || null,
      telegramUser.first_name || "Telegram User",
      telegramUser.last_name || null,
      telegramUser.photo_url || null,
    ],
  );

  return result.rows[0];
}

export async function findUserById(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${USERS_TABLE}
      WHERE id::TEXT = $1::TEXT
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

export async function findUserByTelegramId(telegramId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${USERS_TABLE}
      WHERE telegram_id::TEXT = $1::TEXT
      LIMIT 1
    `,
    [String(telegramId)],
  );

  return result.rows[0] || null;
}

export async function findActiveSubscription(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM (
        SELECT
          id::TEXT AS id,
          user_key AS user_id,
          plan_id::TEXT AS plan_id,
          status::TEXT AS status,
          payment_method::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          CASE WHEN plan_id = 'max' THEN 3 ELSE 2 END AS priority
        FROM ${SUBSCRIPTIONS_TABLE}
        WHERE user_key = $1::TEXT
          AND status = 'active'
          AND expires_at > NOW()

        UNION ALL

        SELECT
          ('trial-' || id::TEXT) AS id,
          user_key AS user_id,
          'free'::TEXT AS plan_id,
          status::TEXT AS status,
          'free-trial'::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          1 AS priority
        FROM ${FREE_TRIALS_TABLE}
        WHERE user_key = $1::TEXT
          AND status = 'active'
          AND expires_at > NOW()
      ) active_access
      ORDER BY priority DESC, created_at DESC
      LIMIT 1
    `,
    [String(userId)],
  );

  return result.rows[0] || null;
}

export async function hasUsedFreeTrial(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT 1
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = $1::TEXT
      LIMIT 1
    `,
    [String(userId)],
  );

  return Boolean(result.rows[0]);
}

function toFreeTrialSubscription(trial) {
  return {
    id: `trial-${trial.id}`,
    user_id: trial.user_key,
    plan_id: "free",
    status: trial.status,
    payment_method: "free-trial",
    starts_at: trial.starts_at,
    expires_at: trial.expires_at,
    created_at: trial.created_at,
    updated_at: trial.updated_at,
  };
}

function isActiveTrialRow(trial) {
  return Boolean(
    trial &&
      trial.status === "active" &&
      trial.expires_at &&
      new Date(trial.expires_at).getTime() > Date.now(),
  );
}

function freeTrialUsedError() {
  const error = new Error(
    "The 3-day free trial has already been used for this Telegram account.",
  );
  error.code = "FREE_TRIAL_USED";
  return error;
}

async function findStoredFreeTrial(client, userId) {
  const result = await client.query(
    `
      SELECT *
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [String(userId)],
  );

  return result.rows[0] || null;
}

async function activateFreeTrial(client, userId) {
  const storedTrial = await findStoredFreeTrial(client, userId);

  if (isActiveTrialRow(storedTrial)) {
    return toFreeTrialSubscription(storedTrial);
  }

  if (storedTrial) {
    throw freeTrialUsedError();
  }

  const activePaidResult = await client.query(
    `
      SELECT 1
      FROM ${SUBSCRIPTIONS_TABLE}
      WHERE user_key = $1::TEXT
        AND status = 'active'
        AND expires_at > NOW()
      LIMIT 1
    `,
    [String(userId)],
  );

  if (activePaidResult.rows[0]) {
    const error = new Error(
      "You already have an active subscription. The free trial cannot replace it.",
    );
    error.code = "ACTIVE_SUBSCRIPTION_EXISTS";
    throw error;
  }

  await client.query("SAVEPOINT free_trial_insert");

  try {
    const result = await client.query(
      `
        INSERT INTO ${FREE_TRIALS_TABLE} (
          user_key,
          status,
          starts_at,
          expires_at,
          updated_at
        )
        VALUES (
          $1::TEXT,
          'active',
          NOW(),
          NOW() + INTERVAL '3 days',
          NOW()
        )
        RETURNING *
      `,
      [String(userId)],
    );

    await client.query("RELEASE SAVEPOINT free_trial_insert");
    return toFreeTrialSubscription(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT free_trial_insert");

    if (error?.code === "23505") {
      const concurrentTrial = await findStoredFreeTrial(client, userId);

      if (isActiveTrialRow(concurrentTrial)) {
        return toFreeTrialSubscription(concurrentTrial);
      }

      throw freeTrialUsedError();
    }

    throw error;
  }
}

async function recordPaidDemoPayment({
  userId,
  subscriptionId,
  planId,
  amount,
  paymentMethod,
}) {
  const reference = `DEMO-${Date.now()}-${subscriptionId}`;

  await pool.query(
    `
      INSERT INTO ${PAYMENTS_TABLE} (
        user_key,
        subscription_id,
        plan_id,
        amount_usd,
        payment_method,
        status,
        transaction_reference
      )
      VALUES ($1::TEXT, $2::TEXT, $3, $4, $5, 'demo_paid', $6)
    `,
    [
      String(userId),
      String(subscriptionId),
      planId,
      amount,
      paymentMethod,
      reference,
    ],
  );
}

export async function activateSubscription({
  userId,
  planId,
  paymentMethod = "khqr-demo",
  recordPayment = true,
}) {
  await ensureSchema();

  const plans = {
    free: { amount: 0, days: 3 },
    pro: { amount: 2, days: 30 },
    premium: { amount: 5, days: 180 },
    max: { amount: 10, days: 365 },
  };

  const selectedPlan = plans[planId];

  if (!selectedPlan) {
    const error = new Error("Invalid subscription plan.");
    error.code = "INVALID_PLAN";
    throw error;
  }

  const client = await pool.connect();
  let subscription;

  try {
    await client.query("BEGIN");

    const lockedUser = await client.query(
      `SELECT id FROM ${USERS_TABLE} WHERE id::TEXT = $1::TEXT FOR UPDATE`,
      [String(userId)],
    );

    if (!lockedUser.rows[0]) {
      const error = new Error(
        "Telegram account was not found. Please log in again.",
      );
      error.code = "USER_NOT_FOUND";
      throw error;
    }

    if (planId === "free") {
      subscription = await activateFreeTrial(client, userId);
    } else {
      await client.query(
        `
          UPDATE ${SUBSCRIPTIONS_TABLE}
          SET status = 'expired', updated_at = NOW()
          WHERE user_key = $1::TEXT
            AND status = 'active'
        `,
        [String(userId)],
      );

      // A paid plan replaces any currently active free trial. This prevents
      // trial access from reappearing after a paid plan is revoked or expires.
      await client.query(
        `
          UPDATE ${FREE_TRIALS_TABLE}
          SET status = 'cancelled', updated_at = NOW()
          WHERE user_key = $1::TEXT
            AND status = 'active'
        `,
        [String(userId)],
      );

      const subscriptionResult = await client.query(
        `
          INSERT INTO ${SUBSCRIPTIONS_TABLE} (
            user_key,
            plan_id,
            status,
            payment_method,
            starts_at,
            expires_at,
            updated_at
          )
          VALUES (
            $1::TEXT,
            $2,
            'active',
            $3,
            NOW(),
            CASE
              WHEN $4::INTEGER IS NULL THEN NULL
              ELSE NOW() + ($4::INTEGER * INTERVAL '1 day')
            END,
            NOW()
          )
          RETURNING *
        `,
        [
          String(userId),
          planId,
          paymentMethod,
          selectedPlan.days,
        ],
      );

      subscription = {
        ...subscriptionResult.rows[0],
        user_id: subscriptionResult.rows[0].user_key,
      };
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (planId !== "free" && recordPayment) {
    try {
      await recordPaidDemoPayment({
        userId,
        subscriptionId: subscription.id,
        planId,
        amount: selectedPlan.amount,
        paymentMethod,
      });
    } catch (paymentError) {
      console.warn("Subscription activated but payment history was not saved:", {
        message: paymentError?.message,
        code: paymentError?.code,
      });
    }
  }

  return subscription;
}


function normalizeText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeByteCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

const FREE_DAILY_COMPRESSION_LIMIT = 3;
const COMPRESSION_QUOTA_TIME_ZONE = "Asia/Phnom_Penh";

function publicCompressionQuota({ planId, used = 0, resetAt = null }) {
  const unlimited = planId === "pro" || planId === "premium" || planId === "max";
  const normalizedUsed = Math.max(0, Number(used) || 0);

  return {
    planId,
    unlimited,
    limit: unlimited ? null : FREE_DAILY_COMPRESSION_LIMIT,
    used: unlimited ? 0 : normalizedUsed,
    remaining: unlimited
      ? null
      : Math.max(0, FREE_DAILY_COMPRESSION_LIMIT - normalizedUsed),
    resetAt: unlimited || !resetAt ? null : new Date(resetAt).toISOString(),
    timeZone: COMPRESSION_QUOTA_TIME_ZONE,
  };
}

async function readFreeCompressionUsage(userId, client = pool) {
  const result = await client.query(
    `
      SELECT
        COALESCE(usage.usage_count, 0)::INTEGER AS usage_count,
        (
          (date_trunc('day', NOW() AT TIME ZONE $2) + INTERVAL '1 day')
          AT TIME ZONE $2
        ) AS reset_at
      FROM (SELECT 1) seed
      LEFT JOIN ${DAILY_COMPRESSION_USAGE_TABLE} usage
        ON usage.user_key = $1::TEXT
       AND usage.usage_date = (NOW() AT TIME ZONE $2)::DATE
      LIMIT 1
    `,
    [String(userId), COMPRESSION_QUOTA_TIME_ZONE],
  );

  return {
    used: Number(result.rows[0]?.usage_count || 0),
    resetAt: result.rows[0]?.reset_at || null,
  };
}

export async function getCompressionQuota(userId) {
  await ensureSchema();

  const subscription = await findActiveSubscription(userId);
  if (!subscription) {
    const error = new Error("An active subscription is required.");
    error.code = "SUBSCRIPTION_REQUIRED";
    throw error;
  }

  const planId = String(subscription.plan_id || "").toLowerCase();
  if (planId !== "free") {
    return publicCompressionQuota({ planId });
  }

  const usage = await readFreeCompressionUsage(userId);
  return publicCompressionQuota({
    planId,
    used: usage.used,
    resetAt: usage.resetAt,
  });
}

export async function reserveCompressionQuota(userId) {
  await ensureSchema();

  // Always re-read access from PostgreSQL instead of trusting the signed
  // browser session. This makes plan upgrades/revocations take effect here.
  const subscription = await findActiveSubscription(userId);
  if (!subscription) {
    const error = new Error("An active subscription is required.");
    error.code = "SUBSCRIPTION_REQUIRED";
    throw error;
  }

  const planId = String(subscription.plan_id || "").toLowerCase();
  if (planId !== "free") {
    return publicCompressionQuota({ planId });
  }

  const result = await pool.query(
    `
      INSERT INTO ${DAILY_COMPRESSION_USAGE_TABLE} (
        user_key,
        usage_date,
        usage_count
      )
      VALUES (
        $1::TEXT,
        (NOW() AT TIME ZONE $2)::DATE,
        1
      )
      ON CONFLICT (user_key, usage_date)
      DO UPDATE SET
        usage_count = ${DAILY_COMPRESSION_USAGE_TABLE}.usage_count + 1,
        updated_at = NOW()
      WHERE ${DAILY_COMPRESSION_USAGE_TABLE}.usage_count < $3
      RETURNING usage_count
    `,
    [String(userId), COMPRESSION_QUOTA_TIME_ZONE, FREE_DAILY_COMPRESSION_LIMIT],
  );

  const usage = await readFreeCompressionUsage(userId);
  const quota = publicCompressionQuota({
    planId,
    used: usage.used,
    resetAt: usage.resetAt,
  });

  if (!result.rows[0]) {
    const error = new Error(
      `FREE plan daily limit reached (${FREE_DAILY_COMPRESSION_LIMIT}/${FREE_DAILY_COMPRESSION_LIMIT}).`,
    );
    error.code = "DAILY_FREE_LIMIT_REACHED";
    error.quota = quota;
    throw error;
  }

  return quota;
}

export async function recordCompressionEvent({
  userId,
  inputName,
  outputName,
  inputBytes,
  outputBytes,
  outputMime,
}) {
  await ensureSchema();

  const result = await pool.query(
    `
      INSERT INTO ${COMPRESSION_EVENTS_TABLE} (
        user_key,
        input_name,
        output_name,
        input_bytes,
        output_bytes,
        output_mime
      )
      SELECT
        id::TEXT,
        $2,
        $3,
        $4,
        $5,
        $6
      FROM ${USERS_TABLE}
      WHERE id::TEXT = $1::TEXT
      RETURNING *
    `,
    [
      String(userId),
      normalizeText(inputName),
      normalizeText(outputName),
      normalizeByteCount(inputBytes),
      normalizeByteCount(outputBytes),
      normalizeText(outputMime, 120),
    ],
  );

  if (!result.rows[0]) {
    const error = new Error("Telegram account was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  return result.rows[0];
}

const ACTIVE_ACCESS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT access.*
    FROM (
      SELECT
        plan_id::TEXT AS plan_id,
        status::TEXT AS status,
        starts_at,
        expires_at,
        2 AS priority
      FROM ${SUBSCRIPTIONS_TABLE}
      WHERE user_key = u.id::TEXT
        AND status = 'active'
        AND expires_at > NOW()

      UNION ALL

      SELECT
        'free'::TEXT AS plan_id,
        status::TEXT AS status,
        starts_at,
        expires_at,
        1 AS priority
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = u.id::TEXT
        AND status = 'active'
        AND expires_at > NOW()
    ) access
    ORDER BY priority DESC, starts_at DESC
    LIMIT 1
  ) active_access ON TRUE
`;

export async function getAdminStats() {
  await ensureSchema();

  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM ${USERS_TABLE}) AS total_users,
      (SELECT COUNT(*)::INTEGER FROM ${USERS_TABLE} WHERE last_login_at >= NOW() - INTERVAL '24 hours') AS users_last_24h,
      (SELECT COUNT(*)::INTEGER FROM ${SUBSCRIPTIONS_TABLE} WHERE status = 'active' AND expires_at > NOW()) AS active_paid,
      (SELECT COUNT(*)::INTEGER FROM ${FREE_TRIALS_TABLE} WHERE status = 'active' AND expires_at > NOW()) AS active_trials,
      (SELECT COUNT(*)::INTEGER FROM ${COMPRESSION_EVENTS_TABLE}) AS total_compressions,
      (SELECT COUNT(*)::INTEGER FROM ${COMPRESSION_EVENTS_TABLE} WHERE created_at >= NOW() - INTERVAL '24 hours') AS compressions_last_24h,
      (SELECT COUNT(*)::INTEGER FROM ${PAYMENTS_TABLE}) AS total_payments,
      (SELECT COALESCE(SUM(amount_usd), 0)::NUMERIC FROM ${PAYMENTS_TABLE} WHERE status = 'demo_paid') AS total_payment_amount
  `);

  return result.rows[0];
}

export async function listAdminUsers({ page = 1, pageSize = 8 } = {}) {
  await ensureSchema();

  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safePageSize = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 8)));
  const offset = (safePage - 1) * safePageSize;

  const [countResult, usersResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::INTEGER AS total FROM ${USERS_TABLE}`),
    pool.query(
      `
        SELECT
          u.*,
          active_access.plan_id AS active_plan_id,
          active_access.status AS active_status,
          active_access.starts_at AS active_starts_at,
          active_access.expires_at AS active_expires_at
        FROM ${USERS_TABLE} u
        ${ACTIVE_ACCESS_LATERAL}
        ORDER BY u.last_login_at DESC, u.id DESC
        LIMIT $1 OFFSET $2
      `,
      [safePageSize, offset],
    ),
  ]);

  return {
    users: usersResult.rows,
    total: countResult.rows[0]?.total || 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function findAdminUser(lookup) {
  await ensureSchema();

  const normalized = String(lookup || "").trim().replace(/^@/, "");
  if (!normalized) return null;

  const result = await pool.query(
    `
      SELECT
        u.*,
        active_access.plan_id AS active_plan_id,
        active_access.status AS active_status,
        active_access.starts_at AS active_starts_at,
        active_access.expires_at AS active_expires_at
      FROM ${USERS_TABLE} u
      ${ACTIVE_ACCESS_LATERAL}
      WHERE u.telegram_id::TEXT = $1::TEXT
         OR u.id::TEXT = $1::TEXT
         OR LOWER(COALESCE(u.username, '')) = LOWER($1)
      ORDER BY u.last_login_at DESC
      LIMIT 1
    `,
    [normalized],
  );

  return result.rows[0] || null;
}

export async function getAdminUserCompressionStats(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        COUNT(*)::INTEGER AS total_compressions,
        COALESCE(SUM(input_bytes), 0)::TEXT AS total_input_bytes,
        COALESCE(SUM(output_bytes), 0)::TEXT AS total_output_bytes,
        MAX(created_at) AS last_compression_at
      FROM ${COMPRESSION_EVENTS_TABLE}
      WHERE user_key = $1::TEXT
    `,
    [String(userId)],
  );

  return result.rows[0];
}

export async function listAdminUserCompressionEvents(userId, limit = 5) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${COMPRESSION_EVENTS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [String(userId), Math.min(10, Math.max(1, Number(limit) || 5))],
  );

  return result.rows;
}

export async function listAdminUserAccessHistory(userId, limit = 6) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM (
        SELECT
          plan_id::TEXT AS plan_id,
          status::TEXT AS status,
          starts_at,
          expires_at,
          payment_method::TEXT AS payment_method,
          created_at
        FROM ${SUBSCRIPTIONS_TABLE}
        WHERE user_key = $1::TEXT

        UNION ALL

        SELECT
          'free'::TEXT AS plan_id,
          status::TEXT AS status,
          starts_at,
          expires_at,
          'free-trial'::TEXT AS payment_method,
          created_at
        FROM ${FREE_TRIALS_TABLE}
        WHERE user_key = $1::TEXT
      ) access_history
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [String(userId), Math.min(12, Math.max(1, Number(limit) || 6))],
  );

  return result.rows;
}

export async function listAdminUserPayments(userId, limit = 5) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${PAYMENTS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [String(userId), Math.min(10, Math.max(1, Number(limit) || 5))],
  );

  return result.rows;
}

export async function listAdminActiveSubscriptions(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        s.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${SUBSCRIPTIONS_TABLE} s
      LEFT JOIN ${USERS_TABLE} u ON u.id::TEXT = s.user_key
      WHERE s.status = 'active'
        AND s.expires_at > NOW()
      ORDER BY s.created_at DESC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}

export async function listAdminActiveTrials(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        t.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${FREE_TRIALS_TABLE} t
      LEFT JOIN ${USERS_TABLE} u ON u.id::TEXT = t.user_key
      WHERE t.status = 'active'
        AND t.expires_at > NOW()
      ORDER BY t.expires_at ASC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}

export async function listAdminRecentPayments(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        p.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${PAYMENTS_TABLE} p
      LEFT JOIN ${USERS_TABLE} u ON u.id::TEXT = p.user_key
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}


const ADMIN_PAID_PLANS = new Set(["pro", "premium", "max"]);

/**
 * Force a user back onto the FREE plan from the Telegram admin bot.
 * This is an admin override, so it may reactivate/restart a FREE trial that
 * the user has used before. Active paid plans are cancelled first.
 * The daily FREE compression counter is intentionally preserved so the
 * global 3-videos-per-Cambodia-day rule cannot be bypassed by plan changes.
 */
export async function setAdminFreePlan({ lookup, adminTelegramId }) {
  await ensureSchema();
  const user = await findAdminUser(lookup);

  if (!user) {
    const error = new Error("User was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT id FROM ${USERS_TABLE} WHERE id::TEXT = $1::TEXT FOR UPDATE`,
      [String(user.id)],
    );

    await client.query(
      `
        UPDATE ${SUBSCRIPTIONS_TABLE}
        SET status = 'cancelled', updated_at = NOW()
        WHERE user_key = $1::TEXT
          AND status = 'active'
      `,
      [String(user.id)],
    );

    const trialResult = await client.query(
      `
        INSERT INTO ${FREE_TRIALS_TABLE} (
          user_key,
          status,
          starts_at,
          expires_at,
          updated_at
        )
        VALUES (
          $1::TEXT,
          'active',
          NOW(),
          NOW() + INTERVAL '3 days',
          NOW()
        )
        ON CONFLICT (user_key)
        DO UPDATE SET
          status = 'active',
          starts_at = NOW(),
          expires_at = NOW() + INTERVAL '3 days',
          updated_at = NOW()
        RETURNING *
      `,
      [String(user.id)],
    );

    await client.query("COMMIT");

    return {
      user,
      subscription: toFreeTrialSubscription(trialResult.rows[0]),
      changedBy: String(adminTelegramId || ""),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Assign a paid plan from the Telegram admin bot. Public website requests do
 * not call this function. The caller must verify TELEGRAM_ADMIN_IDS first.
 */
export async function grantAdminSubscription({
  lookup,
  planId,
  adminTelegramId,
}) {
  const normalizedPlan = String(planId || "").trim().toLowerCase();

  if (!ADMIN_PAID_PLANS.has(normalizedPlan)) {
    const error = new Error("Plan must be PRO, PREMIUM, or MAX.");
    error.code = "INVALID_PAID_PLAN";
    throw error;
  }

  const user = await findAdminUser(lookup);

  if (!user) {
    const error = new Error("User was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  const adminId = String(adminTelegramId || "").replace(/[^0-9-]/g, "").slice(0, 20);
  const paymentMethod = adminId
    ? `telegram-admin:${adminId}`
    : "telegram-admin";

  const subscription = await activateSubscription({
    userId: user.id,
    planId: normalizedPlan,
    paymentMethod,
    recordPayment: false,
  });

  return {
    user,
    subscription,
  };
}

/** Cancel only active paid plans. Free-trial history is preserved. */
export async function revokeAdminSubscription({ lookup }) {
  await ensureSchema();
  const user = await findAdminUser(lookup);

  if (!user) {
    const error = new Error("User was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  const result = await pool.query(
    `
      UPDATE ${SUBSCRIPTIONS_TABLE}
      SET status = 'cancelled', updated_at = NOW()
      WHERE user_key = $1::TEXT
        AND status = 'active'
      RETURNING *
    `,
    [String(user.id)],
  );

  return {
    user,
    revoked: result.rows,
  };
}


export async function getTikTokConnection(userId) {
  await ensureSchema();
  const result = await pool.query(
    `SELECT * FROM ${TIKTOK_CONNECTIONS_TABLE} WHERE user_key = $1::TEXT LIMIT 1`,
    [String(userId)],
  );
  return result.rows[0] || null;
}

export async function saveTikTokConnection({
  userId,
  openId,
  displayName,
  avatarUrl,
  grantedScopes,
  encryptedAccessToken,
  encryptedRefreshToken,
  accessTokenExpiresAt,
  refreshTokenExpiresAt,
}) {
  await ensureSchema();
  const result = await pool.query(
    `
      INSERT INTO ${TIKTOK_CONNECTIONS_TABLE} (
        user_key, open_id, display_name, avatar_url, granted_scopes,
        encrypted_access_token, encrypted_refresh_token,
        access_token_expires_at, refresh_token_expires_at, updated_at
      ) VALUES ($1::TEXT, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (user_key) DO UPDATE SET
        open_id = EXCLUDED.open_id,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        granted_scopes = EXCLUDED.granted_scopes,
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
        updated_at = NOW()
      RETURNING *
    `,
    [
      String(userId),
      String(openId),
      displayName || null,
      avatarUrl || null,
      String(grantedScopes || ""),
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    ],
  );
  return result.rows[0];
}

export async function updateTikTokConnectionTokens({
  userId,
  openId,
  grantedScopes,
  encryptedAccessToken,
  encryptedRefreshToken,
  accessTokenExpiresAt,
  refreshTokenExpiresAt,
}) {
  await ensureSchema();
  const result = await pool.query(
    `
      UPDATE ${TIKTOK_CONNECTIONS_TABLE}
      SET open_id = $2,
          granted_scopes = $3,
          encrypted_access_token = $4,
          encrypted_refresh_token = $5,
          access_token_expires_at = $6,
          refresh_token_expires_at = $7,
          updated_at = NOW()
      WHERE user_key = $1::TEXT
      RETURNING *
    `,
    [
      String(userId),
      String(openId),
      String(grantedScopes || ""),
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    ],
  );
  return result.rows[0] || null;
}

export async function updateTikTokConnectionProfile({ userId, displayName, avatarUrl }) {
  await ensureSchema();
  const result = await pool.query(
    `
      UPDATE ${TIKTOK_CONNECTIONS_TABLE}
      SET display_name = $2, avatar_url = $3, updated_at = NOW()
      WHERE user_key = $1::TEXT
      RETURNING *
    `,
    [String(userId), displayName || null, avatarUrl || null],
  );
  return result.rows[0] || null;
}

export async function deleteTikTokConnection(userId) {
  await ensureSchema();
  await pool.query(`DELETE FROM ${TIKTOK_CONNECTIONS_TABLE} WHERE user_key = $1::TEXT`, [String(userId)]);
}

export async function createTikTokUpload({ userId, publishId, filename, byteSize, mimeType }) {
  await ensureSchema();
  const result = await pool.query(
    `
      INSERT INTO ${TIKTOK_UPLOADS_TABLE} (
        user_key, publish_id, filename, byte_size, mime_type, status, updated_at
      ) VALUES ($1::TEXT, $2, $3, $4, $5, 'INITIALIZED', NOW())
      RETURNING *
    `,
    [String(userId), publishId, filename, byteSize, mimeType],
  );
  return result.rows[0];
}

export async function getTikTokUploadForUser(userId, publishId) {
  await ensureSchema();
  const result = await pool.query(
    `SELECT * FROM ${TIKTOK_UPLOADS_TABLE} WHERE user_key = $1::TEXT AND publish_id = $2 LIMIT 1`,
    [String(userId), String(publishId)],
  );
  return result.rows[0] || null;
}

export async function updateTikTokUploadStatus({
  userId,
  publishId,
  status,
  errorCode = null,
  supportLogId = null,
  uploadedBytes = 0,
  completed = false,
}) {
  await ensureSchema();
  const result = await pool.query(
    `
      UPDATE ${TIKTOK_UPLOADS_TABLE}
      SET status = $3,
          tiktok_error_code = $4,
          support_log_id = $5,
          uploaded_bytes = GREATEST(uploaded_bytes, $6::BIGINT),
          updated_at = NOW(),
          completed_at = CASE WHEN $7::BOOLEAN THEN COALESCE(completed_at, NOW()) ELSE completed_at END
      WHERE user_key = $1::TEXT AND publish_id = $2
      RETURNING *
    `,
    [String(userId), String(publishId), status, errorCode, supportLogId, uploadedBytes, completed],
  );
  return result.rows[0] || null;
}

export async function countRecentTikTokUploadInits(userId, seconds = 60) {
  await ensureSchema();
  const result = await pool.query(
    `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${TIKTOK_UPLOADS_TABLE}
      WHERE user_key = $1::TEXT
        AND created_at > NOW() - ($2::INTEGER * INTERVAL '1 second')
    `,
    [String(userId), seconds],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function findActiveTikTokUpload(userId) {
  await ensureSchema();
  const result = await pool.query(
    `
      SELECT *
      FROM ${TIKTOK_UPLOADS_TABLE}
      WHERE user_key = $1::TEXT
        AND (
          (status = 'INITIALIZED' AND updated_at > NOW() - INTERVAL '20 minutes')
          OR
          (status IN ('PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD')
            AND updated_at > NOW() - INTERVAL '24 hours')
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [String(userId)],
  );
  return result.rows[0] || null;
}
