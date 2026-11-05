"use strict";
const { applyLedgerEntry, enqueueOutbox, recordCampaignEvent } = require("./platform-v4");

async function createCampaign(client, input) {
  const { ownerId, channelUsername, channelTitle, slots, rewardPerMember, category = "عام", description = null, imageUrl = null, expiresAt = null, initialStatus = "active" } = input;
  if (!Number.isInteger(Number(slots)) || Number(slots) < 1 || Number(slots) > 10000) throw new Error("Invalid campaign slots");
  if (!Number.isInteger(Number(rewardPerMember)) || Number(rewardPerMember) < 1) throw new Error("Invalid campaign reward");
  const cost = BigInt(slots) * BigInt(rewardPerMember);
  const owner = await client.query("SELECT points,is_banned FROM users WHERE telegram_id=$1 FOR UPDATE", [String(ownerId)]);
  if (!owner.rowCount || owner.rows[0].is_banned) throw new Error("Campaign owner is unavailable");
  if (BigInt(owner.rows[0].points) < cost) throw new Error("Insufficient points to fund campaign");
  const inserted = await client.query(
    "INSERT INTO campaigns(owner_id,channel_username,channel_title,slots_total,slots_remaining,reward_per_member,category,description,image_url,expires_at,status) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
    [String(ownerId), channelUsername, channelTitle || channelUsername, Number(slots), Number(rewardPerMember), category, description, imageUrl, expiresAt, initialStatus]
  );
  const campaign = inserted.rows[0];
  await applyLedgerEntry(client, { userId: ownerId, amount: (-cost).toString(), reason: "campaign_funding", referenceId: campaign.id, idempotencyKey: "campaign:" + campaign.id + ":funding" });
  await recordCampaignEvent(client, campaign.id, ownerId, "created", { slots: Number(slots), reward_per_member: Number(rewardPerMember), cost: cost.toString() });
  await enqueueOutbox(client, "campaign.created", { campaignId: campaign.id, ownerId: String(ownerId), status: campaign.status });
  return campaign;
}

async function cancelCampaign(client, campaignId, actorId, reason = "cancelled") {
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [Number(campaignId)]);
  if (!found.rowCount) return { cancelled: false, reason: "not_found" };
  const campaign = found.rows[0];
  if (["cancelled", "expired"].includes(campaign.status)) return { cancelled: false, reason: "not_active" };
  const pending = await client.query("SELECT COUNT(*)::int count FROM campaign_claims WHERE campaign_id=$1 AND verification_status='pending'",[campaign.id]);
  if (campaign.status === "completed" && Number(pending.rows[0].count) === 0) return { cancelled: false, reason: "not_active" };
  const refundableSlots=BigInt(campaign.slots_remaining)+BigInt(pending.rows[0].count);
  const refund = refundableSlots * BigInt(campaign.reward_per_member);
  await client.query("UPDATE campaign_claims SET verification_status='rejected',reward_paid=FALSE WHERE campaign_id=$1 AND verification_status='pending'",[campaign.id]);
  if (refund > 0n) {
    await applyLedgerEntry(client, { userId: campaign.owner_id, amount: refund.toString(), reason: "campaign_refund", referenceId: campaign.id, idempotencyKey: "campaign:" + campaign.id + ":refund" });
  }
  await client.query("UPDATE campaigns SET status='cancelled',slots_remaining=0,cancelled_at=NOW(),updated_at=NOW() WHERE id=$1", [campaign.id]);
  await recordCampaignEvent(client, campaign.id, actorId, "cancelled", { refund: refund.toString(), reason });
  await enqueueOutbox(client, "campaign.cancelled", { campaignId: campaign.id, ownerId: String(campaign.owner_id), refund: refund.toString() });
  return { cancelled: true, refund: refund.toString(), ownerId: String(campaign.owner_id) };
}

async function renewCampaign(client, oldCampaignId, ownerId, initialStatus = "active") {
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 AND owner_id=$2", [Number(oldCampaignId), String(ownerId)]);
  if (!found.rowCount) throw new Error("Campaign not found or not owned by user");
  const old = found.rows[0];
  const channel = await client.query("SELECT 1 FROM channel_owners WHERE owner_id=$1 AND username=REPLACE($2,'@','') AND verified=TRUE", [String(ownerId), old.channel_username]);
  if (!channel.rowCount) throw new Error("The channel is not saved and verified for this owner");
  const renewed = await createCampaign(client, {
    ownerId,
    channelUsername: old.channel_username,
    channelTitle: old.channel_title,
    slots: old.slots_total,
    rewardPerMember: old.reward_per_member,
    category: old.category,
    description: old.description,
    imageUrl: old.image_url,
    expiresAt: null,
    initialStatus
  });
  await recordCampaignEvent(client, renewed.id, ownerId, "renewed_from", { sourceCampaignId: old.id });
  return renewed;
}

async function changeCampaignStatus(client, campaignId, actorId, action) {
  const transitions = {
    pause: { from: ["active"], to: "paused" },
    resume: { from: ["paused"], to: "active" },
    reopen: { from: ["completed", "expired"], to: "active" }
  };
  const transition = transitions[action];
  if (!transition) throw new Error("Unsupported campaign transition");
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [Number(campaignId)]);
  if (!found.rowCount) return { changed: false, reason: "not_found" };
  const campaign = found.rows[0];
  if (!transition.from.includes(campaign.status)) return { changed: false, reason: "invalid_state", status: campaign.status };
  if (action === "reopen" && Number(campaign.slots_remaining) < 1) return { changed: false, reason: "no_remaining_slots" };
  await client.query("UPDATE campaigns SET status=$1,updated_at=NOW() WHERE id=$2", [transition.to, campaign.id]);
  await recordCampaignEvent(client, campaign.id, actorId, action, { from: campaign.status, to: transition.to });
  await enqueueOutbox(client, "campaign." + action, { campaignId: campaign.id, ownerId: String(campaign.owner_id) });
  return { changed: true, status: transition.to };
}

async function reviewCampaign(client, campaignId, adminId, approved, reason = null) {
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [Number(campaignId)]);
  if (!found.rowCount || found.rows[0].status !== "pending_review") return { reviewed: false, reason: "not_pending_review" };
  const campaign = found.rows[0];
  if (approved) {
    await client.query("UPDATE campaigns SET status='active',reviewed_by=$1,reviewed_at=NOW(),rejection_reason=NULL,updated_at=NOW() WHERE id=$2", [String(adminId), campaign.id]);
    await recordCampaignEvent(client, campaign.id, adminId, "approved", {});
    await enqueueOutbox(client, "campaign.approved", { campaignId: campaign.id, ownerId: String(campaign.owner_id) });
    return { reviewed: true, approved: true };
  }
  const result = await cancelCampaign(client, campaign.id, adminId, reason || "rejected_by_review");
  await client.query("UPDATE campaigns SET reviewed_by=$1,reviewed_at=NOW(),rejection_reason=$2 WHERE id=$3", [String(adminId), reason || "rejected_by_review", campaign.id]);
  await recordCampaignEvent(client, campaign.id, adminId, "rejected", { reason: reason || "rejected_by_review", refund: result.refund || "0" });
  return { reviewed: true, approved: false, refund: result.refund || "0", ownerId: String(campaign.owner_id) };
}

async function updateCampaignDetails(client, campaignId, ownerId, patch) {
  const allowed = ["description", "image_url", "category", "expires_at"];
  const keys = Object.keys(patch).filter(key => allowed.includes(key));
  if (!keys.length) throw new Error("No editable campaign fields supplied");
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [Number(campaignId)]);
  if (!found.rowCount || String(found.rows[0].owner_id) !== String(ownerId)) throw new Error("Campaign not found or not owned by user");
  if (["cancelled", "completed", "expired"].includes(found.rows[0].status)) throw new Error("Campaign is no longer editable");
  const sets = [], values = [Number(campaignId)];
  for (const key of keys) {
    values.push(patch[key]);
    sets.push(key + "=$" + values.length);
  }
  sets.push("updated_at=NOW()");
  await client.query("UPDATE campaigns SET " + sets.join(",") + " WHERE id=$1", values);
  await recordCampaignEvent(client, campaignId, ownerId, "details_updated", { fields: keys });
  return true;
}

module.exports = { createCampaign, cancelCampaign, changeCampaignStatus, reviewCampaign, renewCampaign, updateCampaignDetails };
