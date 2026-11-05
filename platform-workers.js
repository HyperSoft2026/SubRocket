"use strict";
const { applyLedgerEntry, enqueueOutbox, recordCampaignEvent } = require("./platform-v4");

function reputationLevel(score) {
  if (score >= 90) return 5;
  if (score >= 70) return 4;
  if (score >= 45) return 3;
  if (score >= 20) return 2;
  return 1;
}

async function refreshReputation(client, userId, retained, violation) {
  await client.query(
    "INSERT INTO user_reputation(user_id,verified_claims,retained_claims,violations) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET verified_claims=user_reputation.verified_claims+$2,retained_claims=user_reputation.retained_claims+$3,violations=user_reputation.violations+$4,last_calculated_at=NOW()",
    [String(userId), retained ? 1 : 0, retained ? 1 : 0, violation ? 1 : 0]
  );
  const r = await client.query("SELECT verified_claims,retained_claims,violations FROM user_reputation WHERE user_id=$1 FOR UPDATE", [String(userId)]);
  const row = r.rows[0];
  const score = Math.max(0, Math.min(100, Number(row.verified_claims) * 2 + Number(row.retained_claims) * 5 - Number(row.violations) * 10));
  await client.query("UPDATE user_reputation SET score=$1,level=$2,last_calculated_at=NOW() WHERE user_id=$3", [score, reputationLevel(score), String(userId)]);
}

async function processRetentionQueue(pool, bot, rewardReferral, limit = 25) {
  const due = await pool.query(
    "SELECT cl.id,cl.campaign_id,cl.user_id,c.channel_username FROM campaign_claims cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.verification_status='pending' AND cl.verification_due_at<=NOW() ORDER BY cl.verification_due_at,cl.id LIMIT $1",
    [limit]
  );
  let verified = 0, rejected = 0, deferred = 0;
  for (const item of due.rows) {
    let isMember;
    try {
      const member = await bot.telegram.getChatMember(item.channel_username, String(item.user_id));
      isMember = ["member", "administrator", "creator"].includes(member.status) || (member.status === "restricted" && member.is_member === true);
    } catch (error) {
      await pool.query("UPDATE campaign_claims SET verification_attempts=verification_attempts+1,verification_due_at=NOW()+INTERVAL '10 minutes' WHERE id=$1 AND verification_status='pending'", [item.id]);
      deferred++;
      console.error("Retention membership check deferred:", { claimId: item.id, error: error.description || error.message });
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT cl.*,c.status campaign_status,c.slots_remaining,c.owner_id FROM campaign_claims cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.id=$1 FOR UPDATE OF cl,c",
        [item.id]
      );
      if (!current.rowCount || current.rows[0].verification_status !== "pending") {
        await client.query("ROLLBACK");
        continue;
      }
      const claim = current.rows[0];
      if (isMember) {
        await client.query("UPDATE campaign_claims SET verification_status='verified',verified_at=NOW(),reward_paid=TRUE WHERE id=$1", [claim.id]);
        await applyLedgerEntry(client, {
          userId: claim.user_id,
          amount: String(claim.reward),
          reason: "campaign_reward",
          referenceId: claim.campaign_id,
          idempotencyKey: "claim:" + claim.id + ":retention-reward"
        });
        await refreshReputation(client, claim.user_id, true, false);
        if (rewardReferral) await rewardReferral(client, pool, claim.user_id);
        await recordCampaignEvent(client, claim.campaign_id, null, "claim_retained", { claimId: claim.id, userId: String(claim.user_id) });
        await enqueueOutbox(client, "claim.verified", { claimId: claim.id, campaignId: claim.campaign_id, userId: String(claim.user_id), reward: claim.reward });
        verified++;
      } else {
        await client.query("UPDATE campaign_claims SET verification_status='rejected',reward_paid=FALSE WHERE id=$1", [claim.id]);
        await client.query("UPDATE campaigns SET slots_remaining=slots_remaining+1,status=CASE WHEN status='completed' THEN 'active' ELSE status END,updated_at=NOW() WHERE id=$1", [claim.campaign_id]);
        await refreshReputation(client, claim.user_id, false, true);
        await recordCampaignEvent(client, claim.campaign_id, null, "claim_left_before_retention", { claimId: claim.id, userId: String(claim.user_id) });
        await enqueueOutbox(client, "claim.rejected", { claimId: claim.id, campaignId: claim.campaign_id, userId: String(claim.user_id) });
        rejected++;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Retention processing failed:", { claimId: item.id, error: error.message });
    } finally {
      client.release();
    }
  }
  return { checked: due.rowCount, verified, rejected, deferred };
}

async function expireCampaigns(pool, limit = 25) {
  const due = await pool.query("SELECT id FROM campaigns WHERE status IN ('active','paused','pending_review') AND expires_at IS NOT NULL AND expires_at<=NOW() ORDER BY expires_at LIMIT $1", [limit]);
  let expired = 0;
  for (const item of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [item.id]);
      if (!r.rowCount || !["active", "paused", "pending_review"].includes(r.rows[0].status) || !r.rows[0].expires_at || new Date(r.rows[0].expires_at) > new Date()) {
        await client.query("ROLLBACK");
        continue;
      }
      const c = r.rows[0];
      const pending = await client.query("SELECT COUNT(*)::int count FROM campaign_claims WHERE campaign_id=$1 AND verification_status='pending'",[c.id]);
      const refundableSlots=BigInt(c.slots_remaining)+BigInt(pending.rows[0].count);
      const refund = refundableSlots * BigInt(c.reward_per_member);
      await client.query("UPDATE campaign_claims SET verification_status='rejected',reward_paid=FALSE WHERE campaign_id=$1 AND verification_status='pending'",[c.id]);
      if (refund > 0n) {
        await applyLedgerEntry(client, { userId: c.owner_id, amount: refund.toString(), reason: "campaign_expiry_refund", referenceId: c.id, idempotencyKey: "campaign:" + c.id + ":expiry-refund" });
      }
      await client.query("UPDATE campaigns SET status='expired',slots_remaining=0,updated_at=NOW() WHERE id=$1", [c.id]);
      await recordCampaignEvent(client, c.id, null, "expired", { refund: refund.toString() });
      await enqueueOutbox(client, "campaign.expired", { campaignId: c.id, ownerId: String(c.owner_id), refund: refund.toString() });
      await client.query("COMMIT");
      expired++;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Campaign expiry failed:", { campaignId: item.id, error: error.message });
    } finally {
      client.release();
    }
  }
  return { expired };
}

async function processOutbox(pool, bot, limit = 25) {
  let delivered = 0;
  for (let i = 0; i < limit; i++) {
    const client = await pool.connect();
    let row;
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT * FROM transactional_outbox WHERE processed_at IS NULL AND available_at<=NOW() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      if (!r.rowCount) { await client.query("COMMIT"); break; }
      row = r.rows[0];
      const payload = row.payload || {};
      const userId = payload.userId || payload.ownerId;
      let message = null;
      if (row.event_type === "claim.verified") message = "✅ تم التأكد من استمرار اشتراكك في الحملة #" + payload.campaignId + "، وأضيفت لك " + payload.reward + " نقطة.";
      if (row.event_type === "claim.rejected") message = "⚠️ لم يتم العثور على اشتراكك عند إعادة التحقق للحملة #" + payload.campaignId + "، لذلك لم تُصرف المكافأة.";
      if (row.event_type === "campaign.expired") message = "⏳ انتهت الحملة #" + payload.campaignId + " وتم إرجاع " + payload.refund + " نقطة غير مستخدمة إلى رصيدك.";
      if (row.event_type === "campaign.cancelled") message = "⛔ أُلغيت الحملة #" + payload.campaignId + " وتم إرجاع " + payload.refund + " نقطة غير مستخدمة إلى رصيدك.";
      if (row.event_type === "campaign.created") message = "🚀 تم إنشاء حملتك #" + payload.campaignId + " بنجاح.";
      if (row.event_type === "campaign.approved") message = "✅ تمت الموافقة على حملتك #" + payload.campaignId + " وأصبحت متاحة للمستخدمين.";
      if (message && userId) await bot.telegram.sendMessage(String(userId), message);
      await client.query("UPDATE transactional_outbox SET processed_at=NOW(),last_error=NULL WHERE id=$1", [row.id]);
      await client.query("COMMIT");
      delivered++;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (row) {
        await pool.query("UPDATE transactional_outbox SET attempts=attempts+1,last_error=$2,available_at=NOW()+LEAST(INTERVAL '1 hour',INTERVAL '30 seconds'*POWER(2,LEAST(attempts,7))) WHERE id=$1 AND processed_at IS NULL", [row.id, error.description || error.message || "delivery failed"]).catch(() => {});
      }
      if (error.response && error.response.error_code === 403) {
        // A blocked bot cannot deliver; retain the outbox record for audit/manual handling.
      }
      break;
    } finally {
      client.release();
    }
  }
  return { delivered };
}

function startPlatformWorkers(pool, bot, rewardReferral, intervalMs = 60000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const enabled = await pool.query("SELECT value FROM bot_settings WHERE key='retention_verification_enabled'");
      if (enabled.rows[0] && enabled.rows[0].value === "true") await processRetentionQueue(pool, bot, rewardReferral);
      await expireCampaigns(pool);
      await processOutbox(pool, bot);
    } catch (error) {
      console.error("Platform worker cycle failed:", error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  run();
  return () => clearInterval(timer);
}

module.exports = { processRetentionQueue, expireCampaigns, processOutbox, startPlatformWorkers };
