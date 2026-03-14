// src/services/sendBulkEmailToModash.js
const mongoose = require("mongoose");

const AdminEmailThreadModel = require("../model/adminEmailThread");
const AdminEmailMessageModel = require("../model/adminEmailMessage");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const { CampaignModel } = require("../model/compaign");
const { AdminModel } = require("../model/admin");
const ModashModel = require("../model/modash");
const { collabOpportunityBulkTemplate } = require("../template/collabOpportunityBulk");

const cleanStr = (v) => String(v ?? "").trim();

const toObjectIdStrict = (id, fieldName) => {
  const clean = cleanStr(id);
  if (!mongoose.isValidObjectId(clean)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return new mongoose.Types.ObjectId(clean);
};

const getModashEmail = (m) => {
  const email =
    m?.email ||
    m?.contactEmail ||
    m?.businessEmail ||
    m?.primaryEmail ||
    m?.contact?.email ||
    m?.profile?.email;

  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : null;
};

const getInfluencerName = (m) => {
  return (
    cleanStr(m?.name) ||
    cleanStr(m?.fullName) ||
    cleanStr(m?.displayName) ||
    cleanStr(m?.profile?.name) ||
    cleanStr(m?.username) ||
    "there"
  );
};

const getCampaignTitle = (c) => {
  return (
    cleanStr(c?.title) ||
    cleanStr(c?.name) ||
    cleanStr(c?.campaignTitle) ||
    "our campaign"
  );
};

async function sendBulkEmailToModashByCampaignId(input) {
  const campaignId = cleanStr(input?.campaignId);
  const executiveId = cleanStr(input?.executiveId);
  const from = cleanStr(input?.from).toLowerCase();
  const modashIds = Array.isArray(input?.modashIds)
    ? input.modashIds.map(cleanStr).filter(Boolean)
    : [];

  if (!mongoose.isValidObjectId(campaignId)) {
    throw new Error("Invalid campaignId");
  }

  if (!mongoose.isValidObjectId(executiveId)) {
    throw new Error("Invalid executiveId");
  }

  if (!from) {
    throw new Error("from is required");
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

  const brandObj = new mongoose.Types.ObjectId(String(campaign.brandId));
  const campaignTitle = getCampaignTitle(campaign);

  const admin = await AdminModel.findById(executiveId)
    .select("name proxyEmail proxyemail")
    .lean();

  const executiveName = cleanStr(admin?.name) || "Team CollabGlam";

  const modashObjIds = modashIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const modashDocs = await ModashModel.find({ _id: { $in: modashObjIds } })
    .select(
      "_id email contactEmail businessEmail primaryEmail contact profile name fullName displayName username"
    )
    .lean();

  const modashMap = new Map();
  for (const doc of modashDocs) {
    modashMap.set(String(doc._id), doc);
  }

  const results = [];

  for (const mid of modashIds) {
    try {
      if (!mongoose.isValidObjectId(mid)) {
        results.push({
          modashId: mid,
          success: false,
          error: "Invalid modashId",
        });
        continue;
      }

      const doc = modashMap.get(mid);

      if (!doc) {
        results.push({
          modashId: mid,
          success: false,
          error: "Modash record not found",
        });
        continue;
      }

      const to = getModashEmail(doc);

      if (!to) {
        results.push({
          modashId: mid,
          success: false,
          error: "Email not found for this modashId",
        });
        continue;
      }

      const influencerName = getInfluencerName(doc);
      const modashObj = new mongoose.Types.ObjectId(mid);

      let thread = await AdminEmailThreadModel.findOne({
        campaignId: campObj,
        executiveId: execObj,
        modashId: modashObj,
      });

      if (!thread) {
        try {
          thread = await AdminEmailThreadModel.create({
            brandId: brandObj,
            campaignId: campObj,
            executiveId: execObj,
            modashId: modashObj,
            executiveEmail: to,
            subject: "Collab Opportunity",
            lastMessageAt: new Date(),
          });
        } catch (e) {
          if (e?.code === 11000) {
            thread = await AdminEmailThreadModel.findOne({
              campaignId: campObj,
              executiveId: execObj,
              modashId: modashObj,
            });
          } else {
            throw e;
          }
        }
      } else {
        thread.executiveEmail = to;
        thread.lastMessageAt = new Date();
        await thread.save();
      }

      if (!thread?._id) {
        throw new Error("Thread create failed");
      }

      const templ = collabOpportunityBulkTemplate({
        influencerName,
        campaignTitle,
        replyToEmail: from,
        executiveName,
      });

      const emailMsg = await AdminEmailMessageModel.create({
        threadId: thread._id,
        direction: "OUTBOUND",
        subject: templ.subject,
        from,
        to: [to],
      });

      const emailResp = await sendEmail({
        to,
        subject: templ.subject,
        text: templ.text,
        html: templ.html,
        from,
      });

      const messageId = emailResp?.messageId || null;

      let s3Key = null;

      try {
        s3Key = await uploadEmailRecordToS3({
          type: "OUTBOUND_EMAIL",
          provider: "SES",
          threadId: String(thread._id),
          emailMessageId: String(emailMsg._id),
          campaignId,
          brandId: String(brandObj),
          executiveId: String(execObj),
          modashId: String(modashObj),
          to,
          from,
          subject: templ.subject,
          text: templ.text,
          html: templ.html,
          sesMessageId: messageId,
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error("S3 upload failed:", e?.message || e);
      }

      await AdminEmailMessageModel.updateOne(
        { _id: emailMsg._id },
        {
          $set: {
            messageId: messageId || undefined,
            s3Key: s3Key || undefined,
            s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET || undefined,
          },
        }
      );

      results.push({
        modashId: mid,
        to,
        threadId: String(thread._id),
        emailMessageId: String(emailMsg._id),
        sesMessageId: messageId,
        s3Key,
        success: true,
      });
    } catch (err) {
      results.push({
        modashId: mid,
        success: false,
        error: err?.message || "Failed",
      });
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.length - sent;

  return {
    campaignId,
    executiveId,
    from,
    campaignTitle,
    total: results.length,
    sent,
    failed,
    results,
  };
}

module.exports = {
  sendBulkEmailToModashByCampaignId,
};