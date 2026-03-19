const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");

const AdminEmailThreadModel = require("../models/adminEmailThread");
const AdminEmailMessageModel = require("../models/adminEmailMessage");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const { AdminModel, ROLES } = require("../models/master");
const CampaignImport = require("../models/campaign");
const { collabOpportunityBulkTemplate } = require("../template/collabOpportunityBulk");

const CampaignModel =
  CampaignImport?.CampaignModel || CampaignImport?.default || CampaignImport;

const cleanStr = (value) => String(value ?? "").trim();
const cleanEmail = (value) => cleanStr(value).toLowerCase();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function toObjectIdStrict(id, fieldName) {
  const clean = cleanStr(id);
  if (!mongoose.isValidObjectId(clean)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return new mongoose.Types.ObjectId(clean);
}

function getCampaignTitle(campaign) {
  return (
    cleanStr(campaign?.title) ||
    cleanStr(campaign?.name) ||
    cleanStr(campaign?.campaignTitle) ||
    "our campaign"
  );
}

function buildThreadReplyAddress(threadId) {
  const domain = process.env.INBOUND_REPLY_DOMAIN || "mail.collabglam.cloud";
  return `reply+t_${threadId}@${domain}`.toLowerCase();
}

function parseRecipientsFromCsv(csvBuffer) {
  const text = csvBuffer.toString("utf-8");

  let rows = [];
  try {
    rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    rows = [];
  }

  const pick = (row, keys) => {
    for (const key of keys) {
      if (row?.[key] != null && String(row[key]).trim()) {
        return String(row[key]).trim();
      }
    }
    return "";
  };

  const recipients = [];

  for (const row of rows) {
    const email = pick(row, [
      "email",
      "Email",
      "EMAIL",
      "mail",
      "Mail",
      "influencerEmail",
      "creatorEmail",
    ]);

    const name = pick(row, [
      "name",
      "Name",
      "fullName",
      "Full Name",
      "creatorName",
      "influencerName",
    ]);

    if (!email) continue;

    recipients.push({
      name,
      email,
    });
  }

  if (!recipients.length) {
    const rawRows = parse(text, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
    });

    for (const row of rawRows) {
      const name = cleanStr(row?.[0]);
      const email = cleanStr(row?.[1]);

      if (!email) continue;

      recipients.push({
        name,
        email,
      });
    }
  }

  const seen = new Set();

  return recipients
    .map((item) => ({
      name: cleanStr(item.name),
      email: cleanEmail(item.email),
    }))
    .filter((item) => item.email && isValidEmail(item.email))
    .filter((item) => {
      if (seen.has(item.email)) return false;
      seen.add(item.email);
      return true;
    });
}

async function createOrGetThread({
  brandId,
  campaignId,
  executiveId,
  role,
  senderEmail,
  recipientEmail,
  subject,
}) {
  let thread = await AdminEmailThreadModel.findOne({
    campaignId,
    executiveId,
    recipientEmail,
  });

  if (!thread) {
    thread = await AdminEmailThreadModel.create({
      brandId,
      campaignId,
      executiveId,
      role,
      senderEmail,
      recipientEmail,
      replyToEmail: "temp@temp.local",
      subject,
      lastMessageAt: new Date(),
      lastMessageDirection: "OUTBOUND",
    });

    thread.replyToEmail = buildThreadReplyAddress(thread._id);
    await thread.save();
  } else {
    thread.senderEmail = senderEmail;
    thread.recipientEmail = recipientEmail;
    thread.subject = subject;
    thread.lastMessageAt = new Date();
    thread.lastMessageDirection = "OUTBOUND";

    if (!thread.replyToEmail) {
      thread.replyToEmail = buildThreadReplyAddress(thread._id);
    }

    await thread.save();
  }

  return thread;
}

async function sendBulkEmailToCsvByCampaignId(input) {
  const campaignId = cleanStr(input?.campaignId);
  const executiveId = cleanStr(input?.executiveId);

  if (!mongoose.isValidObjectId(campaignId)) {
    throw new Error("Invalid campaignId");
  }

  if (!mongoose.isValidObjectId(executiveId)) {
    throw new Error("Invalid executiveId");
  }

  if (!input?.csvBuffer || !input.csvBuffer.length) {
    throw new Error("CSV file is required");
  }

  const admin = await AdminModel.findById(executiveId)
    .select("name email proxyEmail role status")
    .lean();

  if (!admin) {
    throw new Error("Admin not found");
  }

  if (!admin.role || ![ROLES.IME, ROLES.BME].includes(admin.role)) {
    throw new Error("Only IME or BME can send bulk emails");
  }

  if (admin.status !== "active") {
    throw new Error("Admin account is not active");
  }

  const from = cleanEmail(admin.proxyEmail || admin.email);
  if (!from) {
    throw new Error("Sender email missing for this admin");
  }

  const executiveName = cleanStr(admin.name) || "Team CollabGlam";

  const campaign = await CampaignModel.findById(campaignId)
    .select("brandId title name campaignTitle")
    .lean();

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (!campaign.brandId) {
    throw new Error("brandId missing in campaign");
  }

  const brandObj = toObjectIdStrict(campaign.brandId, "brandId");
  const campObj = toObjectIdStrict(campaignId, "campaignId");
  const execObj = toObjectIdStrict(executiveId, "executiveId");
  const campaignTitle = getCampaignTitle(campaign);

  const recipients = parseRecipientsFromCsv(input.csvBuffer);
  if (!recipients.length) {
    throw new Error("No valid recipients found in CSV");
  }

  const results = [];

  for (const recipient of recipients) {
    const to = cleanEmail(recipient.email);
    const influencerName = cleanStr(recipient.name) || "there";

    try {
      const subject = "Collab Opportunity";

      const thread = await createOrGetThread({
        brandId: brandObj,
        campaignId: campObj,
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        subject,
      });

      const templ = collabOpportunityBulkTemplate({
        influencerName,
        campaignTitle,
        replyToEmail: thread.replyToEmail,
        executiveName,
      });

      const emailMessage = await AdminEmailMessageModel.create({
        threadId: thread._id,
        direction: "OUTBOUND",
        subject: templ.subject || subject,
        from,
        to: [to],
        replyTo: [thread.replyToEmail],
        provider: "SES",
        providerStatus: "QUEUED",
        textPreview: templ.text ? templ.text.slice(0, 1000) : null,
        htmlPreview: templ.html ? String(templ.html).slice(0, 2000) : null,
      });

      const { messageId } = await sendEmail({
        to,
        subject: templ.subject,
        text: templ.text,
        html: templ.html,
        from,
        replyTo: [thread.replyToEmail],
        configurationSetName: process.env.SES_CONFIGURATION_SET,
        emailTags: [
          { Name: "threadId", Value: String(thread._id) },
          { Name: "campaignId", Value: String(campObj) },
          { Name: "executiveId", Value: String(execObj) },
          { Name: "role", Value: String(admin.role) },
          { Name: "source", Value: "CSV" },
        ],
      });

      let s3Key = null;

      try {
        s3Key = await uploadEmailRecordToS3({
          type: "OUTBOUND_EMAIL",
          provider: "SES",
          threadId: String(thread._id),
          emailMessageId: String(emailMessage._id),
          campaignId: String(campObj),
          brandId: String(brandObj),
          executiveId: String(execObj),
          to,
          from,
          replyTo: thread.replyToEmail,
          subject: templ.subject,
          text: templ.text,
          html: templ.html,
          sesMessageId: messageId || null,
          createdAt: new Date().toISOString(),
          meta: {
            source: "CSV",
            influencerName,
            role: admin.role,
          },
        });
      } catch (error) {
        console.error("S3 upload failed:", error?.message || error);
      }

      await AdminEmailMessageModel.updateOne(
        { _id: emailMessage._id },
        {
          $set: {
            messageId: messageId || null,
            providerStatus: messageId ? "SENT" : "FAILED",
            s3Key: s3Key || null,
            s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET || null,
          },
        }
      );

      results.push({
        email: to,
        name: influencerName,
        threadId: String(thread._id),
        emailMessageId: String(emailMessage._id),
        sesMessageId: messageId || null,
        replyToEmail: thread.replyToEmail,
        s3Key,
        success: true,
      });
    } catch (error) {
      results.push({
        email: to,
        name: influencerName,
        success: false,
        error: error?.message || "Failed",
      });
    }
  }

  const sent = results.filter((item) => item.success).length;
  const failed = results.length - sent;

  return {
    campaignId: String(campObj),
    executiveId: String(execObj),
    from,
    campaignTitle,
    role: admin.role,
    total: results.length,
    sent,
    failed,
    results,
  };
}

module.exports = {
  sendBulkEmailToCsvByCampaignId,
  parseRecipientsFromCsv,
};