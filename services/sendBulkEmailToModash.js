const mongoose = require("mongoose");

const AdminEmailThreadModel = require("../models/adminEmailThread");
const AdminEmailMessageModel = require("../models/adminEmailMessage");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const CampaignImport = require("../models/campaign");
const { AdminModel, ROLES } = require("../models/master");
const ModashModel = require("../models/modash");
const { collabOpportunityBulkTemplate } = require("../template/collabOpportunityBulk");

const CampaignModel =
  CampaignImport?.CampaignModel || CampaignImport?.default || CampaignImport;

const cleanStr = (value) => String(value ?? "").trim();
const cleanEmail = (value) => cleanStr(value).toLowerCase();

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

function getModashEmail(modash) {
  const email =
    modash?.email ||
    modash?.contactEmail ||
    modash?.businessEmail ||
    modash?.primaryEmail ||
    modash?.contact?.email ||
    modash?.profile?.email;

  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : null;
}

function getInfluencerName(modash) {
  return (
    cleanStr(modash?.name) ||
    cleanStr(modash?.fullName) ||
    cleanStr(modash?.displayName) ||
    cleanStr(modash?.profile?.name) ||
    cleanStr(modash?.username) ||
    "there"
  );
}

function buildThreadReplyAddress(threadId) {
  const domain = process.env.INBOUND_REPLY_DOMAIN || "mail.collabglam.cloud";
  return `reply+t_${threadId}@${domain}`.toLowerCase();
}

async function createOrGetThread({
  brandId,
  campaignId,
  executiveId,
  role,
  senderEmail,
  recipientEmail,
  modashId,
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
      modashId,
      subject,
      lastMessageAt: new Date(),
      lastMessageDirection: "OUTBOUND",
    });

    thread.replyToEmail = buildThreadReplyAddress(thread._id);
    await thread.save();
  } else {
    thread.senderEmail = senderEmail;
    thread.recipientEmail = recipientEmail;
    thread.modashId = modashId;
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

async function sendBulkEmailToModashByCampaignId(input) {
  const campaignId = cleanStr(input?.campaignId);
  const executiveId = cleanStr(input?.executiveId);
  const modashIds = Array.isArray(input?.modashIds)
    ? input.modashIds.map(cleanStr).filter(Boolean)
    : [];

  if (!mongoose.isValidObjectId(campaignId)) {
    throw new Error("Invalid campaignId");
  }

  if (!mongoose.isValidObjectId(executiveId)) {
    throw new Error("Invalid executiveId");
  }

  if (!modashIds.length) {
    throw new Error("modashIds[] is required");
  }

  const execObj = toObjectIdStrict(executiveId, "executiveId");
  const campObj = toObjectIdStrict(campaignId, "campaignId");

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
  const campaignTitle = getCampaignTitle(campaign);

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

  const from = cleanEmail(input?.from || admin.proxyEmail || admin.email);
  if (!from) {
    throw new Error("Sender email missing for this admin");
  }

  const executiveName = cleanStr(admin.name) || "Team CollabGlam";

  const validModashObjIds = modashIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const modashDocs = await ModashModel.find({
    _id: { $in: validModashObjIds },
  })
    .select(
      "_id email contactEmail businessEmail primaryEmail contact profile name fullName displayName username"
    )
    .lean();

  const modashMap = new Map();
  for (const doc of modashDocs) {
    modashMap.set(String(doc._id), doc);
  }

  const results = [];

  for (const modashId of modashIds) {
    try {
      if (!mongoose.isValidObjectId(modashId)) {
        results.push({
          modashId,
          success: false,
          error: "Invalid modashId",
        });
        continue;
      }

      const modashDoc = modashMap.get(modashId);

      if (!modashDoc) {
        results.push({
          modashId,
          success: false,
          error: "Modash record not found",
        });
        continue;
      }

      const to = getModashEmail(modashDoc);
      if (!to) {
        results.push({
          modashId,
          success: false,
          error: "Email not found for this modash record",
        });
        continue;
      }

      const influencerName = getInfluencerName(modashDoc);
      const modashObj = new mongoose.Types.ObjectId(modashId);
      const subject = "Collab Opportunity";

      const thread = await createOrGetThread({
        brandId: brandObj,
        campaignId: campObj,
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        modashId: modashObj,
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
          { Name: "modashId", Value: String(modashObj) },
          { Name: "role", Value: String(admin.role) },
          { Name: "source", Value: "MODASH" },
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
          modashId: String(modashObj),
          to,
          from,
          replyTo: thread.replyToEmail,
          subject: templ.subject,
          text: templ.text,
          html: templ.html,
          sesMessageId: messageId || null,
          createdAt: new Date().toISOString(),
          meta: {
            source: "MODASH",
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
        modashId,
        to,
        threadId: String(thread._id),
        emailMessageId: String(emailMessage._id),
        sesMessageId: messageId || null,
        replyToEmail: thread.replyToEmail,
        s3Key,
        success: true,
      });
    } catch (error) {
      results.push({
        modashId,
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
  sendBulkEmailToModashByCampaignId,
};