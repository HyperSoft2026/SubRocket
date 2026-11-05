"use strict";

const MIGRATION_VERSION = 4;

async function migrateV4(pool, superAdminId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [MIGRATION_VERSION]);
    if (!done.rowCount) {
      const statements = [
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS description TEXT",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS image_url TEXT",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'عام'",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reviewed_by BIGINT",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS rejection_reason TEXT",
        "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_reputation INTEGER NOT NULL DEFAULT 0 CHECK(min_reputation BETWEEN 0 AND 5)",
        "ALTER TABLE campaign_claims ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'verified'",
        "ALTER TABLE campaign_claims ADD COLUMN IF NOT EXISTS reward_paid BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE campaign_claims ADD COLUMN IF NOT EXISTS verification_due_at TIMESTAMPTZ",
        "ALTER TABLE campaign_claims ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ",
        "ALTER TABLE campaign_claims ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0",
        "UPDATE campaign_claims SET verified_at=created_at WHERE verification_status='verified' AND verified_at IS NULL",
        "ALTER TABLE points_ledger ADD COLUMN IF NOT EXISTS idempotency_key TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS points_ledger_idempotency_idx ON points_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS campaign_claims_retention_idx ON campaign_claims(verification_status,verification_due_at) WHERE verification_status='pending'",
        "CREATE TABLE IF NOT EXISTS campaign_events (id BIGSERIAL PRIMARY KEY,campaign_id BIGINT NOT NULL REFERENCES campaigns(id),actor_id BIGINT,action TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE INDEX IF NOT EXISTS campaign_events_campaign_idx ON campaign_events(campaign_id,id DESC)",
        "CREATE TABLE IF NOT EXISTS channel_owners (id BIGSERIAL PRIMARY KEY,owner_id BIGINT NOT NULL REFERENCES users(telegram_id),chat_id BIGINT NOT NULL,username TEXT,title TEXT NOT NULL,verified BOOLEAN NOT NULL DEFAULT FALSE,verified_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(owner_id,chat_id))",
        "CREATE INDEX IF NOT EXISTS channel_owners_user_idx ON channel_owners(owner_id,created_at DESC)",
        "CREATE TABLE IF NOT EXISTS user_reputation (user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id),score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 5),verified_claims INTEGER NOT NULL DEFAULT 0,retained_claims INTEGER NOT NULL DEFAULT 0,violations INTEGER NOT NULL DEFAULT 0,last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS user_favorites (user_id BIGINT NOT NULL REFERENCES users(telegram_id),campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,campaign_id))",
        "CREATE TABLE IF NOT EXISTS reward_tasks (id BIGSERIAL PRIMARY KEY,task_key TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,period TEXT NOT NULL CHECK(period IN ('daily','weekly','monthly','event')),target_count INTEGER NOT NULL CHECK(target_count>0),reward_points BIGINT NOT NULL CHECK(reward_points>0),active BOOLEAN NOT NULL DEFAULT TRUE,starts_at TIMESTAMPTZ,ends_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS user_task_progress (id BIGSERIAL PRIMARY KEY,task_id BIGINT NOT NULL REFERENCES reward_tasks(id),user_id BIGINT NOT NULL REFERENCES users(telegram_id),period_key TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,completed_at TIMESTAMPTZ,rewarded_at TIMESTAMPTZ,UNIQUE(task_id,user_id,period_key))",
        "CREATE TABLE IF NOT EXISTS daily_login_claims (user_id BIGINT NOT NULL REFERENCES users(telegram_id),login_date DATE NOT NULL,streak_days INTEGER NOT NULL DEFAULT 1,reward_points BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,login_date))",
        "CREATE TABLE IF NOT EXISTS staff_members (user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id),role TEXT NOT NULL CHECK(role IN ('admin','moderator','support','analyst')),granted_by BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS moderation_cases (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(telegram_id),reporter_id BIGINT,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','confirmed','dismissed')),reviewed_by BIGINT,reviewed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE TABLE IF NOT EXISTS transactional_outbox (id BIGSERIAL PRIMARY KEY,event_type TEXT NOT NULL,payload JSONB NOT NULL,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,processed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE INDEX IF NOT EXISTS transactional_outbox_pending_idx ON transactional_outbox(available_at,id) WHERE processed_at IS NULL",
        "CREATE TABLE IF NOT EXISTS user_activity (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(telegram_id),event_type TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE INDEX IF NOT EXISTS user_activity_user_idx ON user_activity(user_id,created_at DESC)",
        "CREATE TABLE IF NOT EXISTS platform_health_checks (id BIGSERIAL PRIMARY KEY,component TEXT NOT NULL,status TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      ];
      for (const sql of statements) await client.query(sql);
      // Expand the legacy status check without rewriting or deleting campaign rows.
      const checks = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid='campaigns'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      `);
      for (const row of checks.rows) await client.query('ALTER TABLE campaigns DROP CONSTRAINT "' + row.conname.replace(/"/g, '""') + '"');
      await client.query("ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_v4_check CHECK(status IN ('active','paused','completed','expired','cancelled','pending_review'))");
      await client.query("ALTER TABLE campaign_claims ADD CONSTRAINT campaign_claims_verification_status_check CHECK(verification_status IN ('pending','verified','rejected'))");
      await client.query("INSERT INTO schema_migrations(version,name) VALUES($1,$2)", [MIGRATION_VERSION, "evolution-platform-foundation"]);
    }
    if (superAdminId && /^\d+$/.test(String(superAdminId))) {
      await client.query("INSERT INTO staff_members(user_id,role,granted_by) SELECT telegram_id,'admin',telegram_id FROM users WHERE telegram_id=$1 ON CONFLICT(user_id) DO NOTHING", [String(superAdminId)]);
    }
    await client.query("INSERT INTO bot_settings(key,value) VALUES ('retention_verification_enabled','false'),('retention_hours','24'),('campaign_review_required','false'),('daily_login_reward','10'),('daily_streak_bonus','25') ON CONFLICT(key) DO NOTHING");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const ROLE_PERMISSIONS = Object.freeze({
  admin: ["users.read","users.manage","campaigns.read","campaigns.manage","channels.read","channels.manage","wallet.read","wallet.adjust","rewards.manage","support.read","support.reply","moderation.manage","broadcast.send","analytics.read","settings.manage","audit.read"],
  moderator: ["users.read","campaigns.read","campaigns.manage","channels.read","moderation.manage","audit.read"],
  support: ["support.read","support.reply","users.read"],
  analyst: ["analytics.read","users.read","campaigns.read","channels.read","wallet.read","audit.read"]
});

async function hasPermission(pool, userId, permission, superAdminId) {
  if (String(userId) === String(superAdminId)) return true;
  const r = await pool.query("SELECT role FROM staff_members WHERE user_id=$1", [String(userId)]);
  return !!r.rowCount && (ROLE_PERMISSIONS[r.rows[0].role] || []).includes(permission);
}

async function grantStaffRole(pool, actorId, targetId, role, superAdminId) {
  if (!ROLE_PERMISSIONS[role]) throw new Error("Invalid staff role");
  if (String(actorId) !== String(superAdminId)) throw new Error("Only the super admin can grant staff roles");
  await pool.query(
    "INSERT INTO staff_members(user_id,role,granted_by) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,granted_by=EXCLUDED.granted_by,created_at=NOW()",
    [String(targetId), role, String(actorId)]
  );
}

async function applyLedgerEntry(client, entry) {
  const { userId, amount, reason, referenceId = null, idempotencyKey } = entry;
  if (!/^-?\d+$/.test(String(amount)) || BigInt(amount) === 0n) throw new Error("Ledger amount must be a non-zero integer");
  if (!idempotencyKey || String(idempotencyKey).length > 180) throw new Error("A stable idempotencyKey is required");
  const inserted = await client.query(
    "INSERT INTO points_ledger(user_id,amount,reason,reference_id,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id",
    [String(userId), String(amount), reason, referenceId, String(idempotencyKey)]
  );
  if (!inserted.rowCount) return { applied: false, duplicate: true };
  const updated = await client.query(
    "UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2 AND points+$1>=0 RETURNING points",
    [String(amount), String(userId)]
  );
  if (!updated.rowCount) throw new Error("User not found or insufficient balance");
  return { applied: true, duplicate: false, points: updated.rows[0].points };
}

async function enqueueOutbox(client, eventType, payload, availableAt = null) {
  const r = await client.query(
    "INSERT INTO transactional_outbox(event_type,payload,available_at) VALUES($1,$2::jsonb,COALESCE($3::timestamptz,NOW())) RETURNING id",
    [eventType, JSON.stringify(payload), availableAt]
  );
  return r.rows[0].id;
}

async function recordCampaignEvent(client, campaignId, actorId, action, details = {}) {
  await client.query(
    "INSERT INTO campaign_events(campaign_id,actor_id,action,details) VALUES($1,$2,$3,$4::jsonb)",
    [campaignId, actorId == null ? null : String(actorId), action, JSON.stringify(details)]
  );
}

async function recordActivity(client, userId, eventType, details = {}) {
  await client.query(
    "INSERT INTO user_activity(user_id,event_type,details) VALUES($1,$2,$3::jsonb)",
    [String(userId), eventType, JSON.stringify(details)]
  );
}

module.exports = {
  migrateV4,
  hasPermission,
  grantStaffRole,
  applyLedgerEntry,
  enqueueOutbox,
  recordCampaignEvent,
  recordActivity,
  ROLE_PERMISSIONS
};
