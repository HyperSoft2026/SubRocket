"use strict";
const { applyLedgerEntry, enqueueOutbox, recordCampaignEvent } = require("./platform-v4");

async function createCampaign(client, input) {
  const { ownerId, channelUsername, channelTitle, slots, rewardPerMember, category = "عام", description = null, imageUrl = null, expiresAt = null } = input;
  if (!Number.isInteger(Number(slots)) || Number(slots) < 1 || Number(slots) > 10000) throw new Error("Invalid campaign slots");
  if (!Number.isInteger(Number(rewardPerMember)) || Number(rewardPerMember) < 1) throw new Error("Invalid campaign reward");
  const cost = BigInt(slots) * BigInt(rewardPerMember);
  const owner = await client.query("SELECT points,is_banned FROM users WHERE telegram_id=$1 FOR UPDATE", [String(ownerId)]);
  if (!owner.rowCount || owner.rows[0].is_banned) throw new Error("Campaign owner is unavailable");
  if (BigInt(owner.rows[0].points) < cost) throw new Error("Insufficient points to fund campaign");
  const inserted = await client.query(
    "INSERT INTO campaigns(owner_id,channel_username,channel_title,slots_total,slots_remaining,reward_per_member,category,description,image_url,expires_at,status) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'active') RETURNING *",
    [String(ownerId), channelUsername, channelTitle || channelUsername, Number(slots), Number(rewardPerMember), category, description, imageUrl, expiresAt]
  );
  const campaign = inserted.rows[0];
  await applyLedgerEntry(client, { userId: ownerId, amount: (-cost).toString(), reason: "campaign_funding", referenceId: campaign.id, idempotencyKey: "campaign:" + campaign.id + ":funding" });
  await recordCampaignEvent(client, campaign.id, ownerId, "created", { slots: Number(slots), reward_per_member: Number(rewardPerMember), cost: cost.toString() });
  await enqueueOutbox(client, "campaign.created", { campaignId: campaign.id, ownerId: String(ownerId) });
  return campaign;
}

async function cancelCampaign(client, campaignId, actorId, reason = "cancelled") {
  const found = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [Number(campaignId)]);
  if (!found.rowCount) return { cancelled: false, reason: "not_found" };
  const campaign = found.rows[0];
  if (["cancelled", "expired", "completed"].includes(campaign.status)) return { cancelled: false, reason: "not_active" };
  const refund = BigInt(campaign.slots_remaining) * BigInt(campaign.reward_per_member);
  if (refund > 0n) {
    await applyLedgerEntry(client, { userId: campaign.owner_id, amount: refund.toString(), reason: "campaign_refund", referenceId: campaign.id, idempotencyKey: "campaign:" + campaign.id + ":refund" });
  }
  await client.query("UPDATE campaigns SET status='cancelled',slots_remaining=0,cancelled_at=NOW(),updated_at=NOW() WHERE id=$1", [campaign.id]);
  await recordCampaignEvent(client, campaign.id, actorId, "cancelled", { refund: refund.toString(), reason });
  await enqueueOutbox(client, "campaign.cancelled", { campaignId: campaign.id, ownerId: String(campaign.owner_id), refund: refund.toString() });
  return { cancelled: true, refund: refund.toString(), ownerId: String(campaign.owner_id) };
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

module.exports = { createCampaign, cancelCampaign, changeCampaignStatus, updateCampaignDetails };
