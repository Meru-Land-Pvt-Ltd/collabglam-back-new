const mongoose = require("mongoose");
const AdminEmailThreadModel = require("../models/adminEmailThread.js");
const AdminEmailMessageModel = require("../models/adminEmailMessage.js");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const CampaignModel = require("../models/campaign.js");
const { brandOutreachEmailTemplate } = require("../template/brandOutreach");
const {
  cleanEmail,
  buildThreadReplyAddress,
  buildReferences,
} = require("./emailThreadHelpers");

async function sendEmailToBrandByCampaignId(input) {
  const { campaignId, subject, text, html, executiveId, role } = input;

  const from = cleanEmail(process.env.MARKETING_EMAIL);
  if (!from) throw new Error("MARKETING_EMAIL is missing");

  const campaign = await CampaignModel.findById(campaignId)
    .select("brandId")
    .populate({
      path: "brandId",
      select: "email businessEmail contactEmail primaryEmail",
    });

  if (!campaign) throw new Error("Campaign not found");

  const brand = campaign.brandId;
  const to = cleanEmail(
    brand?.email || brand?.businessEmail || brand?.contactEmail || brand?.primaryEmail
  );
  if (!to) throw new Error("Brand email not found");

  let thread = await AdminEmailThreadModel.findOne({
    campaignId,
    executiveId,
    recipientEmail: to,
  });

  if (!thread) {
    thread = await AdminEmailThreadModel.create({
      brandId: brand._id,
      campaignId,
      executiveId,
      role,
      senderEmail: from,
      recipientEmail: to,
      replyToEmail: "temp@temp.local",
      subject: String(subject).trim(),
      lastMessageAt: new Date(),
      lastMessageDirection: "OUTBOUND",
    });

    thread.replyToEmail = buildThreadReplyAddress(thread._id);
    await thread.save();
  }

  const lastMsg = await AdminEmailMessageModel.findOne({ threadId: thread._id })
    .sort({ createdAt: -1 })
    .lean();

  const templ = brandOutreachEmailTemplate({
    subject: String(subject).trim(),
    toEmail: to,
    headline: String(subject).trim(),
    introHtml:
      "We’d love to collaborate with you. Please reply to this email for next steps.",
    bodyText: text || undefined,
    bodyHtml: html || undefined,
  });

  const headers = [];
  if (lastMsg?.messageId) {
    headers.push({ name: "In-Reply-To", value: lastMsg.messageId });

    const refs = buildReferences(lastMsg);
    if (refs.length) {
      headers.push({ name: "References", value: refs.join(" ") });
    }
  }

  const emailMsg = await AdminEmailMessageModel.create({
    threadId: thread._id,
    direction: "OUTBOUND",
    subject: templ.subject,
    from,
    to: [to],
    replyTo: [thread.replyToEmail],
    inReplyTo: lastMsg?.messageId || null,
    references: lastMsg ? buildReferences(lastMsg) : [],
    provider: "SES",
    providerStatus: "QUEUED",
    textPreview: templ.text?.slice(0, 1000) || null,
    htmlPreview: templ.html?.slice(0, 2000) || null,
  });

  const { messageId } = await sendEmail({
    to,
    subject: templ.subject,
    text: templ.text,
    html: templ.html,
    from,
    replyTo: [thread.replyToEmail],
    headers,
    configurationSetName: process.env.SES_CONFIGURATION_SET,
    emailTags: [
      { Name: "threadId", Value: String(thread._id) },
      { Name: "campaignId", Value: String(campaignId) },
      { Name: "executiveId", Value: String(executiveId) },
      { Name: "role", Value: String(role || "") },
    ],
  });

  let s3Key = null;
  try {
    s3Key = await uploadEmailRecordToS3({
      type: "OUTBOUND_EMAIL",
      provider: "SES",
      threadId: String(thread._id),
      emailMessageId: String(emailMsg._id),
      campaignId: String(campaignId),
      brandId: String(brand._id),
      executiveId: String(executiveId),
      to,
      from,
      replyTo: thread.replyToEmail,
      subject: templ.subject,
      text: templ.text,
      html: templ.html,
      headers,
      sesMessageId: messageId || null,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("S3 upload failed:", e?.message || e);
  }

  await AdminEmailMessageModel.updateOne(
    { _id: emailMsg._id },
    {
      $set: {
        messageId: messageId || null,
        providerStatus: messageId ? "SENT" : "FAILED",
        s3Key: s3Key || null,
        s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET || null,
      },
    }
  );

  await AdminEmailThreadModel.updateOne(
    { _id: thread._id },
    {
      $set: {
        lastMessageAt: new Date(),
        lastMessageDirection: "OUTBOUND",
        senderEmail: from,
        recipientEmail: to,
      },
    }
  );

  return {
    threadId: String(thread._id),
    emailMessageId: String(emailMsg._id),
    sesMessageId: messageId || null,
    replyToEmail: thread.replyToEmail,
    s3Key,
  };
}

module.exports = { sendEmailToBrandByCampaignId };