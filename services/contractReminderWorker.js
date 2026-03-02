"use strict";

const Contract = require("../models/contract");
const { CONTRACT_STATUS, NEGOTIATION_STATUSES } = require("../constants/contract");
const {
  sendContractEmail,
  reminderToken,
  startReminder,
  clearReminder,
} = require("../services/email/contractEmailService");

async function runReminderSweep() {
  const now = new Date();

  // Check both roles
  await Promise.all(["brand", "influencer"].map((role) => sweepRole(role, now)));
}

async function sweepRole(role, now) {
  const duePath = `reminders.${role}.dueAt`;
  const sentPath = `reminders.${role}.sentCount`;

  // Only when negotiation is active and this role is awaited
  const candidates = await Contract.find({
    status: { $in: NEGOTIATION_STATUSES },
    awaitingRole: role,
    [duePath]: { $ne: null, $lte: now },
    [sentPath]: { $lt: 1 },
  }).limit(200);

  for (const contract of candidates) {
    // If state changed, clear reminder
    if (contract.status === CONTRACT_STATUS.READY_TO_SIGN || contract.editsLockedAt) {
      await clearReminder({ contractId: contract.contractId, role });
      continue;
    }
    if (String(contract.awaitingRole || "") !== role) {
      await clearReminder({ contractId: contract.contractId, role });
      continue;
    }

    // Verify token matches current version (per-version idempotency)
    const expected = reminderToken(contract, role);
    const currentToken = contract?.reminders?.[role]?.token || "";
    if (currentToken && currentToken !== expected) {
      // New version/state: restart timer (don’t send old reminder)
      await startReminder({ contract, role });
      continue;
    }

    // "has not opened/viewed/responded" since timer start:
    // We approximate timer start as dueAt - 30 mins
    const dueAt = contract?.reminders?.[role]?.dueAt;
    const startedAt = dueAt ? new Date(new Date(dueAt).getTime() - 30 * 60 * 1000) : null;

    const lastViewed = contract?.lastViewedAt?.[role] || null;
    if (startedAt && lastViewed && new Date(lastViewed) >= startedAt) {
      // They viewed during the window → reset timer (do NOT send reminder)
      await startReminder({ contract, role });
      continue;
    }

    // Send reminder email
    const to =
      role === "brand"
        ? (contract?.other?.brandProfile?.email || "").trim()
        : (contract?.other?.influencerProfile?.email || "").trim();

    if (!to) {
      // If no email available, just mark as sent to avoid endless retries
      await Contract.updateOne(
        { contractId: contract.contractId },
        { $set: { [`reminders.${role}.sentCount`]: 1, [`reminders.${role}.lastSentAt`]: now } }
      );
      continue;
    }

    const templateKey = role === "brand"
      ? "contract_action_reminder_brand"
      : "contract_action_reminder_influencer";

    await sendContractEmail({
      contract,
      templateKey,
      to,
      recipientRole: role,
      recipientName: role === "brand" ? contract.brandName : contract.influencerName,
    });

    await Contract.updateOne(
      { contractId: contract.contractId },
      { $set: { [`reminders.${role}.sentCount`]: 1, [`reminders.${role}.lastSentAt`]: now } }
    );
  }
}

module.exports = { runReminderSweep };
