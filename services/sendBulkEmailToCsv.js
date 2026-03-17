// src/services/sendBulkEmailToCsv.js
const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");

const AdminEmailThreadModel = require("../models/adminEmailThread.js");
const AdminEmailMessageModel = require("../models/adminEmailMessage.js");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const CampaignImport = require("../models/campaign.js");
const AdminImport = require("../models/master.js");
const { collabOpportunityBulkTemplate } = require("../template/collabOpportunityBulk");

const CampaignModel =
  CampaignImport?.CampaignModel || CampaignImport?.default || CampaignImport;

const AdminModel =
  AdminImport?.AdminModel || AdminImport?.default || AdminImport;

const cleanStr = (v) => String(v ?? "").trim();
const cleanEmail = (v) => cleanStr(v).toLowerCase();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const getCampaignTitle = (c) =>
  cleanStr(c?.title) ||
  cleanStr(c?.name) ||
  cleanStr(c?.campaignTitle) ||
  "our campaign";

function parseRecipientsFromCsv(csvBuffer) {
  const text = csvBuffer.toString("utf-8");

  let rows = [];
  try {
    rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
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
    recipients.push({ name, email });
  }

  if (!recipients.length) {
    const rows2 = parse(text, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
    });

    for (const row of rows2) {
      const name = cleanStr(row?.[0]);
      const email = cleanStr(row?.[1]);
      if (email) recipients.push({ name, email });
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

async function sendBulkEmailToCsvByCampaignId(input) {
  const campaignId = cleanStr(input?.campaignId);
  const executiveId = cleanStr(input?.executiveId);

  console.log("campaignId:", campaignId, "executiveId:", executiveId);

  if (!mongoose.isValidObjectId(campaignId)) {
    throw new Error("Invalid campaignId");
  }

  if (!mongoose.isValidObjectId(executiveId)) {
    throw new Error("Invalid executiveId");
  }

  if (!input?.csvBuffer || !input.csvBuffer.length) {
    throw new Error("CSV file is required");
  }

  if (!AdminModel || typeof AdminModel.findById !== "function") {
    throw new Error("AdminModel import is invalid");
  }

  if (!CampaignModel || typeof CampaignModel.findById !== "function") {
    throw new Error("CampaignModel import is invalid");
  }

  const admin = await AdminModel.findById(executiveId)
    .select("name proxyemail email")
    .lean();

  if (!admin) {
    throw new Error("Admin not found");
  }

  const from = cleanEmail(  "khushikumari@collabglam.com" ||admin.proxyemail || admin.email);
  if (!from) {
    throw new Error("proxyemail missing for this admin/executive");
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

  const brandObj = new mongoose.Types.ObjectId(String(campaign.brandId));
  const campObj = new mongoose.Types.ObjectId(String(campaignId));
  const execObj = new mongoose.Types.ObjectId(String(executiveId));
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
      let thread = await AdminEmailThreadModel.findOne({
        campaignId: campObj,
        executiveId: execObj,
        executiveEmail: to,
      });

      if (!thread) {
        try {
          thread = await AdminEmailThreadModel.create({
            brandId: brandObj,
            campaignId: campObj,
            executiveId: execObj,
            executiveEmail: to,
            subject: "Collab Opportunity",
            lastMessageAt: new Date(),
          });
        } catch (e) {
          if (e?.code === 11000) {
            thread = await AdminEmailThreadModel.findOne({
              campaignId: campObj,
              executiveId: execObj,
              executiveEmail: to,
            });
          } else {
            throw e;
          }
        }
      } else {
        thread.lastMessageAt = new Date();
        thread.subject = "Collab Opportunity";
        await thread.save();
      }

      if (!thread?._id) {
        throw new Error("Thread create failed");
      }

      const emailMsg = await AdminEmailMessageModel.create({
        threadId: thread._id,
        direction: "OUTBOUND",
        subject: "Collab Opportunity",
        from,
        to: [to],
      });

      const templ = collabOpportunityBulkTemplate({
        influencerName,
        campaignTitle,
        replyToEmail: from,
        executiveName,
      });

      const { messageId } = await sendEmail({
        to,
        subject: templ.subject,
        text: templ.text,
        html: templ.html,
        from,
      });

      let s3Key = null;

      try {
        s3Key = await uploadEmailRecordToS3({
          type: "OUTBOUND_EMAIL",
          provider: "SES",
          threadId: String(thread._id),
          emailMessageId: String(emailMsg._id),
          campaignId: String(campObj),
          brandId: String(brandObj),
          executiveId: String(execObj),
          to,
          from,
          subject: templ.subject,
          text: templ.text,
          html: templ.html,
          sesMessageId: messageId || null,
          createdAt: new Date().toISOString(),
          meta: {
            source: "CSV",
            influencerName,
          },
        });
      } catch (e) {
        console.error("S3 upload failed:", e?.message || e);
      }

      await AdminEmailMessageModel.updateOne(
        { _id: emailMsg._id },
        {
          $set: {
            ...(messageId ? { messageId } : {}),
            ...(s3Key ? { s3Key } : {}),
            ...(process.env.EMAIL_ARCHIVE_BUCKET
              ? { s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET }
              : {}),
          },
        }
      );

      results.push({
        email: to,
        name: influencerName,
        threadId: String(thread._id),
        emailMessageId: String(emailMsg._id),
        sesMessageId: messageId || null,
        s3Key,
        success: true,
      });
    } catch (err) {
      results.push({
        email: to,
        name: influencerName,
        success: false,
        error: err?.message || "Failed",
      });
    }
  }

  const sent = results.filter((item) => item.success).length;
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
  sendBulkEmailToCsvByCampaignId,
};