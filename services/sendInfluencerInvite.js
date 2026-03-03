// services/sendInfluencerInvite.js
const mongoose = require("mongoose");
const EmailThreadModel = require("../model/emailthread");
const EmailMessageModel = require("../model/emailMessage");
const { uploadEmailRecordToS3, sendEmail } = require("./emailService");
const { CampaignModel } = require("../model/compaign");
const ModashModel = require("../model/modash");
const { collabOpportunityTemplate } = require("../template/collabOpportunity");

function toObjectIdStrict(id, fieldName) {
  const clean = String(id || "").trim();
  if (!mongoose.isValidObjectId(clean)) throw new Error(`Invalid ${fieldName}`);
  return new mongoose.Types.ObjectId(clean);
}

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

/**
 * @param {{campaignId:string, modashId:string}} input
 */
async function sendInfluencerInviteByCampaign(input) {
  const { campaignId, modashId } = input;

  const campObj = toObjectIdStrict(campaignId, "campaignId");
  const modashObj = toObjectIdStrict(modashId, "modashId");

  const from = process.env.MARKETING_EMAIL;
  if (!from || !String(from).trim()) throw new Error("MARKETING_EMAIL is missing in env");

  // campaign: get brandId + campaignTitle
  const campaign = await CampaignModel.findById(campObj)
    .select("brandId campaignTitle")
    .lean();

  if (!campaign?._id) throw new Error("Campaign not found");
  if (!campaign?.brandId) throw new Error("brandId missing in campaign");

  const brandId = campaign.brandId;
  const campaignTitle = String(campaign.campaignTitle || "").trim() || "Campaign";

  // modash: get email + fullname/username
  const modash = await ModashModel.findById(modashObj)
    .select("email fullname username")
    .lean();

  if (!modash?._id) throw new Error("Modash not found");

  const to = cleanEmail(modash?.email);
  if (!to) throw new Error("Influencer email not found in Modash");

  const influencerName =
    String(modash?.fullname || "").trim() ||
    String(modash?.username || "").trim() ||
    "there";

  // thread reuse ONLY if (brandId + campaignId + executiveEmail)
  let thread = await EmailThreadModel.findOne({
    brandId,
    campaignId: campObj,
    executiveEmail: to,
  }).lean();

  if (!thread?._id) {
    const created = await EmailThreadModel.create({
      brandId,
      campaignId: campObj,
      executiveEmail: to,
      subject: "Collab Opportunity",
      lastMessageAt: new Date(),
    });
    thread = created.toObject();
  } else {
    await EmailThreadModel.updateOne(
      { _id: thread._id },
      { $set: { lastMessageAt: new Date(), executiveEmail: to } }
    );
  }

  // DB message: ONLY metadata (NO body)
  const emailMsg = await EmailMessageModel.create({
    threadId: thread._id,
    direction: "OUTBOUND",
    subject: "Collab Opportunity",
    from: cleanEmail(from),
    to: [to],
  });

  // template
  const templ = collabOpportunityTemplate({
    influencerName,
    campaignTitle,
  });

  // send via SES
  const { messageId } = await sendEmail({
    to,
    subject: templ.subject,
    text: templ.text,
    html: templ.html,
    from,
  });

  // store FULL body in S3
  let s3Key = null;
  try {
    s3Key = await uploadEmailRecordToS3({
      type: "OUTBOUND_EMAIL",
      provider: "SES",
      threadId: String(thread._id),
      emailMessageId: String(emailMsg._id),

      campaignId: String(campObj),
      brandId: String(brandId),

      modashId: String(modashObj),
      influencerName,
      campaignTitle,

      to,
      from,
      subject: templ.subject,
      text: templ.text,
      html: templ.html,
      sesMessageId: messageId || null,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("S3 upload failed:", e?.message || e);
  }

  // update DB pointers
  await EmailMessageModel.updateOne(
    { _id: emailMsg._id },
    {
      $set: {
        messageId: messageId ?? undefined,
        s3Key: s3Key ?? undefined,
        s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET ?? undefined,
      },
    }
  );

  return {
    threadId: String(thread._id),
    emailMessageId: String(emailMsg._id),
    sesMessageId: messageId,
    s3Key,
    to,
    campaignId: String(campObj),
    brandId: String(brandId),

    modashId: String(modashObj),
    campaignTitle,
    influencerName,
  };
}

module.exports = { sendInfluencerInviteByCampaign };