"use strict";

const moment = require("moment-timezone");
const Contract = require("../../models/contract");
const templates = require("./contractTemplates");
const { renderTemplatePack } = require("./render");
const { sendEmail } = require("../../utils/mailer");

// Reminder rule
const REMINDER_MINUTES = 30;

function appUrl(pathname) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const p = String(pathname || "").startsWith("/") ? pathname : `/${pathname || ""}`;
  return base ? `${base}${p}` : p;
}

function contractNameFallback(contract) {
  const fromCampaign = contract?.brand?.campaignTitle;
  if (fromCampaign && String(fromCampaign).trim()) return String(fromCampaign).trim();
  const cid = contract?.contractId ? String(contract.contractId) : "";
  return cid ? `Contract #${cid}` : "your contract";
}

function buildEmailVars({ contract, recipientRole, recipientName }) {
  const ContractName = contractNameFallback(contract);

  const brandName =
    contract?.other?.brandProfile?.legalName ||
    contract?.brandName ||
    "Brand";

  const influencerName =
    contract?.other?.influencerProfile?.legalName ||
    contract?.influencerName ||
    "Influencer";

  const version = Number(contract?.version || 0);

  // Deep links aligned to your existing action paths
  const link =
    recipientRole === "brand"
      ? appUrl(`/brand/created-campaign/applied-inf?id=${contract.campaignId}&infId=${contract.influencerId}`)
      : appUrl(`/influencer/my-campaign`);

  return {
    BrandName: brandName,
    InfluencerName: influencerName,
    UserName: recipientName || (recipientRole === "brand" ? brandName : influencerName),

    ContractName,
    ContractId: String(contract.contractId || ""),
    VersionNumber: String(version),

    PlatformLink: link,
    CTAUrl: link,

    // Optional
    ActionRequiredBy: "",

    SupportEmail: process.env.SUPPORT_EMAIL || "{SupportEmail}",
    CompanyAddress: process.env.COMPANY_ADDRESS || "{CompanyAddress}",
    UnsubscribeLink: process.env.UNSUBSCRIBE_URL || "{UnsubscribeLink}",
  };
}

function reminderToken(contract, role) {
  return `${contract.contractId}:v${Number(contract.version || 0)}:${role}`;
}

async function upsertReminder({ contractId, role, dueAt, token, sentCount, lastSentAt }) {
  const set = {};
  if (dueAt !== undefined) set[`reminders.${role}.dueAt`] = dueAt;
  if (token !== undefined) set[`reminders.${role}.token`] = token;
  if (sentCount !== undefined) set[`reminders.${role}.sentCount`] = sentCount;
  if (lastSentAt !== undefined) set[`reminders.${role}.lastSentAt`] = lastSentAt;

  await Contract.updateOne({ contractId }, { $set: set });
}

async function clearReminder({ contractId, role }) {
  await upsertReminder({
    contractId,
    role,
    dueAt: null,
    token: "",
    sentCount: 0,
    lastSentAt: null,
  });
}

async function startReminder({ contract, role }) {
  const dueAt = new Date(Date.now() + REMINDER_MINUTES * 60 * 1000);
  const token = reminderToken(contract, role);
  await upsertReminder({
    contractId: contract.contractId,
    role,
    dueAt,
    token,
    sentCount: 0,
    lastSentAt: null,
  });
}

async function resetReminderOnEngagement({ contract, role }) {
  // Only reset if this user is still the one awaited for action
  if (String(contract.awaitingRole || "") !== String(role || "")) return;

  const dueAt = new Date(Date.now() + REMINDER_MINUTES * 60 * 1000);
  const token = reminderToken(contract, role);

  // Keep sentCount as-is to enforce: 1 reminder per version per user
  const current = contract?.reminders?.[role] || {};
  await upsertReminder({
    contractId: contract.contractId,
    role,
    dueAt,
    token,
    sentCount: Number(current.sentCount || 0),
    lastSentAt: current.lastSentAt || null,
  });
}

function alreadySent(contract, { event, templateKey, to, version }) {
  const logs = Array.isArray(contract?.emailLog) ? contract.emailLog : [];
  return logs.some((l) => {
    const v = l?.vars?.VersionNumber || l?.vars?.version || "";
    return (
      l?.event === event &&
      l?.templateKey === templateKey &&
      String(l?.to || "") === String(to || "") &&
      String(v) === String(version)
    );
  });
}

async function logEmail(contractId, entry) {
  await Contract.updateOne(
    { contractId },
    { $push: { emailLog: { ...entry, sentAt: entry.sentAt || new Date() } } }
  );
}

async function sendContractEmail({ contract, templateKey, to, recipientRole, recipientName }) {
  const tpl = templates[templateKey];
  if (!tpl) throw new Error(`Unknown templateKey: ${templateKey}`);

  const vars = buildEmailVars({ contract, recipientRole, recipientName });
  const rendered = renderTemplatePack(tpl, vars);

  const version = vars.VersionNumber;

  // Idempotency (avoid duplicates on retries / multiple saves)
  if (alreadySent(contract, { event: tpl.event, templateKey, to, version })) return { skipped: true };

  const idempotencyKey = `${tpl.event}|${contract.contractId}|v${version}|${recipientRole}|${templateKey}`;

  try {
    const resp = await sendEmail({
      to,
      subject: rendered.subject,
      text: rendered.body_text,
      html: rendered.body_html,
      headers: {
        "X-CollabGlam-Event": tpl.event,
        "X-CollabGlam-ContractId": String(contract.contractId || ""),
        "X-CollabGlam-Version": String(version),
        "X-CollabGlam-Idempotency": idempotencyKey,
      },
    });

    await logEmail(contract.contractId, {
      event: tpl.event,
      to,
      subject: rendered.subject,
      templateKey,
      vars,
      providerId: resp.providerId || "",
      error: "",
    });

    return { skipped: false, providerId: resp.providerId || "" };
  } catch (e) {
    await logEmail(contract.contractId, {
      event: tpl.event,
      to,
      subject: rendered.subject,
      templateKey,
      vars,
      providerId: "",
      error: e?.message || String(e),
    });
    throw e;
  }
}

module.exports = {
  templates,
  buildEmailVars,
  sendContractEmail,

  // Reminder controls
  startReminder,
  clearReminder,
  resetReminderOnEngagement,
  reminderToken,
};
