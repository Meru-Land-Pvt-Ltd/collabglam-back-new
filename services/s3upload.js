// services/s3upload.js
const mongoose = require("mongoose");
const AdminEmailThreadModel = require("../models/adminEmailThread.js");
const AdminEmailMessageModel = require("../models/adminEmailMessage.js");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const  CampaignModel  = require("../models/campaign.js");
const { brandOutreachEmailTemplate } = require("../template/brandOutreach");

function toObjectIdStrict(id, fieldName) {
  const clean = String(id || "").trim();
  if (!mongoose.isValidObjectId(clean)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return new mongoose.Types.ObjectId(clean);
}

function getBrandEmail(brand) {
  const email =
    brand?.email ||
    brand?.businessEmail ||
    brand?.contactEmail ||
    brand?.primaryEmail;

  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : null;
}

/**
 * @param {{campaignId:string, subject:string, text?:string, html?:string, executiveId:string}} input
 */
async function sendEmailToBrandByCampaignId(input) {
  const { campaignId, subject, text, html, executiveId } = input;

  if (!mongoose.isValidObjectId(String(campaignId).trim())) {
    throw new Error("Invalid campaignId");
  }
  if (!subject || !String(subject).trim()) {
    throw new Error("subject is required");
  }
  if (!text && !html) {
    throw new Error("Either text or html is required");
  }

  const execObj = toObjectIdStrict(executiveId, "executiveId");
  const campObj = toObjectIdStrict(campaignId, "campaignId");

  const from = process.env.MARKETING_EMAIL;
  if (!from || !String(from).trim()) {
    throw new Error("MARKETING_EMAIL is missing in env");
  }
console.log("Fetching campaign with ID:", campObj);
  const campaign = await CampaignModel.findById(campObj)
    .select("brandId")
    .populate({
      path: "brandId",
      select: "email businessEmail contactEmail primaryEmail",
    })
    .lean();

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const brand = campaign.brandId;
  if (!brand?._id) {
    throw new Error("brandId missing in campaign");
  }

  const to = getBrandEmail(brand);
  if (!to) {
    throw new Error("Brand email not found");
  }

  // thread reuse ONLY when brandId + campaignId + executiveId match
  let thread = await AdminEmailThreadModel.findOne({
    brandId: brand._id,
    campaignId: campObj,
    executiveId: execObj,
  });

  if (!thread) {
    thread = await AdminEmailThreadModel.create({
      brandId: brand._id,
      campaignId: campObj,
      executiveId: execObj,
      executiveEmail: to,
      subject: String(subject).trim(),
      lastMessageAt: new Date(),
    });
  } else {
    thread.executiveEmail = to;
    thread.lastMessageAt = new Date();
    await thread.save();
  }

  // Save DB message WITHOUT body
  const emailMsg = await AdminEmailMessageModel.create({
    threadId: thread._id,
    direction: "OUTBOUND",
    subject: String(subject).trim(),
    from: String(from).trim().toLowerCase(),
    to: [to],
  });

  // Apply template
  const templ = brandOutreachEmailTemplate({
    subject: String(subject).trim(),
    toEmail: to,
    headline: String(subject).trim(),
    introHtml:
      "We’d love to collaborate with you. Please reply to this email for next steps.",
    bodyText: text || undefined,
    bodyHtml: html || undefined,
  });

  // Send SES using template output
  const { messageId } = await sendEmail({
    to,
    subject: templ.subject,
    text: templ.text,
    html: templ.html,
    from,
  });

  // Upload to S3 (store full content)
  let s3Key = null;
  try {
    s3Key = await uploadEmailRecordToS3({
      type: "OUTBOUND_EMAIL",
      provider: "SES",
      threadId: String(thread._id),
      emailMessageId: String(emailMsg._id),
      campaignId: String(campObj),
      brandId: String(brand._id),
      executiveId: String(execObj),
      to,
      from: String(from).trim().toLowerCase(),
      subject: templ.subject,
      text: templ.text,
      html: templ.html,
      sesMessageId: messageId || null,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("S3 upload failed:", e?.message || e);
  }

  // Update DB pointers
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

  return {
    threadId: String(thread._id),
    emailMessageId: String(emailMsg._id),
    sesMessageId: messageId || null,
    s3Key,
    to,
    brandId: String(brand._id),
    campaignId: String(campObj),
    executiveId: String(execObj),
  };
}

module.exports = { sendEmailToBrandByCampaignId };