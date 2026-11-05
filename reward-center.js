"use strict";
const { applyLedgerEntry } = require("./platform-v4");

async function claimDailyReward(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      "SELECT login_date,streak_days FROM daily_login_claims WHERE user_id=$1 ORDER BY login_date DESC LIMIT 1",
      [String(userId)]
    );
    const streak = previous.rowCount
      ? await client.query("SELECT CASE WHEN $1::date=CURRENT_DATE-1 THEN $2::int+1 ELSE 1 END streak", [previous.rows[0].login_date, previous.rows[0].streak_days])
      : { rows: [{ streak: 1 }] };
    const streakDays = Number(streak.rows[0].streak);
    const base = await client.query("SELECT value FROM bot_settings WHERE key='daily_login_reward'");
    const bonus = await client.query("SELECT value FROM bot_settings WHERE key='daily_streak_bonus'");
    const basePoints = BigInt(base.rows[0]?.value || "10");
    const bonusPoints = streakDays > 0 && streakDays % 7 === 0 ? BigInt(bonus.rows[0]?.value || "25") : 0n;
    const total = basePoints + bonusPoints;
    const inserted = await client.query(
      "INSERT INTO daily_login_claims(user_id,login_date,streak_days,reward_points) VALUES($1,CURRENT_DATE,$2,$3) ON CONFLICT(user_id,login_date) DO NOTHING RETURNING login_date",
      [String(userId), streakDays, total.toString()]
    );
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "already_claimed", streakDays };
    }
    const date = await client.query("SELECT CURRENT_DATE::text day");
    await applyLedgerEntry(client, {
      userId,
      amount: total.toString(),
      reason: bonusPoints > 0n ? "daily_login_streak" : "daily_login",
      idempotencyKey: "daily-login:" + String(userId) + ":" + date.rows[0].day
    });
    await client.query("COMMIT");
    return { claimed: true, points: total.toString(), basePoints: basePoints.toString(), bonusPoints: bonusPoints.toString(), streakDays };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getUserAnalytics(pool, userId) {
  const r = await pool.query(`
    SELECT
      u.points,
      (SELECT COUNT(*)::int FROM campaign_claims c WHERE c.user_id=u.telegram_id AND c.verification_status='verified') verified_claims,
      (SELECT COUNT(*)::int FROM campaign_claims c WHERE c.user_id=u.telegram_id AND c.verification_status='pending') pending_claims,
      (SELECT COALESCE(SUM(amount),0)::text FROM points_ledger l WHERE l.user_id=u.telegram_id AND amount>0) earned,
      (SELECT COALESCE(-SUM(amount),0)::text FROM points_ledger l WHERE l.user_id=u.telegram_id AND amount<0) spent,
      (SELECT COUNT(*)::int FROM referrals f WHERE f.referrer_id=u.telegram_id) referrals,
      (SELECT COUNT(*)::int FROM referrals f WHERE f.referrer_id=u.telegram_id AND f.rewarded_at IS NOT NULL) rewarded_referrals,
      COALESCE(rep.score,0)::int reputation_score,
      COALESCE(rep.level,1)::int reputation_level
    FROM users u LEFT JOIN user_reputation rep ON rep.user_id=u.telegram_id
    WHERE u.telegram_id=$1
  `, [String(userId)]);
  return r.rows[0] || null;
}

module.exports = { claimDailyReward, getUserAnalytics };
