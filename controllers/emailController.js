// controllers/emailController.js
"use strict";

const mongoose = require("mongoose");
const { SESClient, SendEmailCommand, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const { v4: uuidv4 } = require("uuid");

const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const Campaign = require("../models/campaign");

const { EmailThread, EmailMessage, EmailTemplate } = require("../models/email");
const CampaignApplication = require("../models/applyCampaign");
const Invitation = require("../models/NewInvitations");
const MissingEmail = require("../models/MissingEmail");

const { buildInvitationEmail } = require("../template/invitationTemplate");
const { uploadToGridFS } = require("../utils/gridfs");
const { getOrCreateBrandAlias, getOrCreateInfluencerAlias } = require("../utils/emailAliases");

// ===============================
// Constants
// ===============================
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB
const BRAND_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 2 days

const DEFAULT_RELAY_DOMAIN = "mail.collabglam.com";
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_MAP = new Map([
  ["youtube", "youtube"],
  ["yt", "youtube"],
  ["instagram", "instagram"],
  ["ig", "instagram"],
  ["tiktok", "tiktok"],
  ["tt", "tiktok"],
]);

// ===============================
// AWS SES Client
// ===============================
const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

// ===============================
// Small helpers
// ===============================
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const safeStr = (v) => (v === null || v === undefined ? "" : String(v));
const safeLower = (v) => safeStr(v).trim().toLowerCase();

function getRelayDomain() {
  return safeLower(process.env.EMAIL_RELAY_DOMAIN || DEFAULT_RELAY_DOMAIN) || DEFAULT_RELAY_DOMAIN;
}

function normalizeHandle(h) {
  const t = safeStr(h).trim();
  if (!t) return "";
  return t.startsWith("@") ? t : `@${t}`;
}

function computeInfluencerDisplayAlias(inf) {
  if (inf?.otpVerified && inf?.name) {
    const local = safeLower(inf.name).replace(/[^a-z0-9]+/g, "").slice(0, 20) || "influencer";
    return `${local}@${getRelayDomain()}`;
  }
  return `influencer@${getRelayDomain()}`;
}

function buildStandardHtml(bodyText) {
  const safe = safeStr(bodyText || "");
  return `<p>${safe.replace(/\n/g, "<br/>")}</p>
<hr/>
<p style="font-size:12px;color:#666;">
  Sent via ${safeStr(process.env.PLATFORM_NAME || "CollabGlam")} – your email is hidden.
</p>`;
}

function renderTemplateString(str, context = {}) {
  if (!str) return str;
  const map = {
    brandName: context.brandName || "",
    influencerName: context.influencerName || "",
    platformName: process.env.PLATFORM_NAME || "CollabGlam",
  };
  return String(str).replace(/{{\s*(brandName|influencerName|platformName)\s*}}/gi, (_, key) => map[key] || "");
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((att) => ({
        filename: att.filename || att.name || "attachment",
        contentType: att.contentType || "application/octet-stream",
        contentBase64: att.contentBase64 || att.content || "",
        size: Number(att.size) || 0,
      }))
    : [];
}

async function uploadEmailAttachmentsToGridFS({ req, safeAttachments, metadata }) {
  if (!safeAttachments.length) return [];

  const filesForGrid = safeAttachments.map((att) => {
    const raw = safeStr(att.contentBase64).trim();
    const base64 = raw.includes(",") ? raw.split(",").pop() : raw;
    if (!base64) {
      const err = new Error(`Attachment "${att.filename}" has no content`);
      err.statusCode = 400;
      throw err;
    }

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      const err = new Error(`Attachment "${att.filename}" is too large. Max allowed size is 20MB.`);
      err.statusCode = 413;
      throw err;
    }

    return { originalname: att.filename, mimetype: att.contentType, buffer, size: buffer.length };
  });

  return uploadToGridFS(filesForGrid, { req, prefix: "email", metadata });
}

// ===============================
// Finders (accept Mongo _id OR UUID-ish ids)
// ===============================
async function findBrandByIdOrBrandId(id) {
  if (!id) return null;

  // prefer business id (uuid)
  const byBusiness = await Brand.findOne({ brandId: id });
  if (byBusiness) return byBusiness;

  // then mongo id
  if (isObjectId(id)) return Brand.findById(id);

  return null;
}

async function findInfluencerByIdOrInfluencerId(id) {
  if (!id) return null;

  const byBusiness = await Influencer.findOne({ influencerId: id });
  if (byBusiness) return byBusiness;

  if (isObjectId(id)) return Influencer.findById(id);

  return null;
}

async function findCampaignByIdOrCampaignsId(id) {
  if (!id) return null;

  const byBusiness = await Campaign.findOne({ campaignsId: id });
  if (byBusiness) return byBusiness;

  if (isObjectId(id)) return Campaign.findById(id);

  return null;
}

// ===============================
// Thread matching (NO CastError)
// ===============================
function threadMatchForBrand(brandDoc) {
  const or = [{ brand: brandDoc._id }];

  // optional string field if you have it in schema
  if (brandDoc.brandId) or.push({ brandId: String(brandDoc.brandId) });

  return { $or: or };
}

// ===============================
// Brand follow-up policy
// ===============================
async function enforceBrandPolicyOrThrow(threadId) {
  const influencerHasReplied = await EmailMessage.exists({ thread: threadId, direction: "influencer_to_brand" });
  if (influencerHasReplied) return;

  const brandCount = await EmailMessage.countDocuments({ thread: threadId, direction: "brand_to_influencer" });

  if (brandCount === 0) return;

  if (brandCount === 1) {
    const first = await EmailMessage.findOne({ thread: threadId, direction: "brand_to_influencer" })
      .sort({ createdAt: 1 })
      .select({ createdAt: 1 })
      .lean();

    const firstAt = first?.createdAt || new Date();
    const nextAllowedAt = new Date(firstAt.getTime() + BRAND_COOLDOWN_MS);

    if (Date.now() < nextAllowedAt.getTime()) {
      const err = new Error(`You can send a follow-up after ${nextAllowedAt.toISOString()}`);
      err.statusCode = 429;
      err.code = "BRAND_EMAIL_COOLDOWN";
      err.meta = { nextAllowedAt };
      throw err;
    }
    return;
  }

  const err = new Error("You already sent a follow-up. Wait for the influencer to reply before sending another email.");
  err.statusCode = 409;
  err.code = "BRAND_WAITING_FOR_REPLY";
  throw err;
}

// ===============================
// Thread creation
// ===============================
async function getOrCreateThread({ brand, influencer, createdBy, subject }) {
  // safest: always match on ObjectId fields only
  let thread = await EmailThread.findOne({ brand: brand._id, influencer: influencer._id });

  if (thread) {
    if (!thread.subject && subject) {
      thread.subject = subject;
      await thread.save();
    }
    return thread;
  }

  const brandAlias = await getOrCreateBrandAlias(brand);
  const influencerAlias = await getOrCreateInfluencerAlias(influencer);

  thread = await EmailThread.create({
    brand: brand._id,
    influencer: influencer._id,

    // OPTIONAL (recommended): store string ids to avoid future casting + make UI queries easy
    brandId: brand.brandId || null,
    influencerId: influencer.influencerId || null,

    brandSnapshot: { name: brand.name, email: brand.email },
    influencerSnapshot: { name: influencer.name || "Influencer", email: influencer.email },

    brandAliasEmail: brandAlias,
    influencerAliasEmail: influencerAlias,

    brandDisplayAlias: brandAlias,
    influencerDisplayAlias: computeInfluencerDisplayAlias(influencer),

    subject: subject || undefined,
    status: "active",
    createdBy: createdBy || "system",
  });

  return thread;
}

// ===============================
// SES sending
// ===============================
async function sendViaSES({ fromAlias, fromName, toRealEmail, subject, htmlBody, textBody, replyTo, attachments }) {
  const nl = "\r\n";

  try {
    // Raw email for attachments
    if (attachments && attachments.length) {
      const mixedBoundary = `Mixed_${uuidv4()}`;
      const altBoundary = `Alt_${uuidv4()}`;

      const headers = [
        `From: ${fromName} <${fromAlias}>`,
        `To: ${toRealEmail}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      ];
      if (replyTo) headers.push(`Reply-To: ${replyTo}`);

      let raw = headers.join(nl) + nl + nl;

      raw += `--${mixedBoundary}${nl}`;
      raw += `Content-Type: multipart/alternative; boundary="${altBoundary}"${nl}${nl}`;

      if (textBody) {
        raw += `--${altBoundary}${nl}`;
        raw += `Content-Type: text/plain; charset="UTF-8"${nl}`;
        raw += `Content-Transfer-Encoding: 7bit${nl}${nl}`;
        raw += `${textBody}${nl}${nl}`;
      }

      if (htmlBody) {
        raw += `--${altBoundary}${nl}`;
        raw += `Content-Type: text/html; charset="UTF-8"${nl}`;
        raw += `Content-Transfer-Encoding: 7bit${nl}${nl}`;
        raw += `${htmlBody}${nl}${nl}`;
      }

      raw += `--${altBoundary}--${nl}${nl}`;

      for (const att of attachments) {
        if (!att) continue;
        const filename = safeStr(att.filename || "attachment").replace(/"/g, "'");
        const contentType = att.contentType || "application/octet-stream";
        const rawContent = safeStr(att.contentBase64 || att.content || "").trim();
        const base64 = rawContent.includes(",") ? rawContent.split(",").pop() : rawContent;
        if (!base64) continue;

        raw += `--${mixedBoundary}${nl}`;
        raw += `Content-Type: ${contentType}; name="${filename}"${nl}`;
        raw += `Content-Disposition: attachment; filename="${filename}"${nl}`;
        raw += `Content-Transfer-Encoding: base64${nl}${nl}`;
        raw += `${base64}${nl}${nl}`;
      }

      raw += `--${mixedBoundary}--`;

      const cmd = new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw) } });
      return await ses.send(cmd);
    }

    // Simple email
    const params = {
      Source: `${fromName} <${fromAlias}>`,
      Destination: { ToAddresses: [toRealEmail] },
      Message: {
        Subject: { Charset: "UTF-8", Data: subject },
        Body: {
          Html: { Charset: "UTF-8", Data: htmlBody || "" },
          Text: { Charset: "UTF-8", Data: textBody || "" },
        },
      },
    };
    if (replyTo) params.ReplyToAddresses = [replyTo];

    const cmd = new SendEmailCommand(params);
    return await ses.send(cmd);
  } catch (err) {
    console.error("SES send error:", err);
    throw err;
  }
}

// ===============================
// Resolve influencer and recipient email (supports invitationId)
// ===============================
async function resolveInfluencerAndEmail({ influencerId, invitationId, brand }) {
  if (influencerId) {
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!influencer) {
      const err = new Error("Influencer not found");
      err.statusCode = 404;
      throw err;
    }
    return {
      influencer,
      influencerName: influencer.name || (influencer.email || "").split("@")[0],
      recipientEmail: influencer.email,
    };
  }

  if (!invitationId) {
    const err = new Error("Either influencerId or invitationId is required");
    err.statusCode = 400;
    throw err;
  }

  const invitation = await Invitation.findOne({ invitationId }).lean();
  if (!invitation) {
    const err = new Error("Invitation not found");
    err.statusCode = 404;
    throw err;
  }

  // ensure invitation belongs to brand (brandId is your string id)
  if (brand?.brandId && invitation.brandId && invitation.brandId !== brand.brandId) {
    const err = new Error("Invitation does not belong to this brand");
    err.statusCode = 403;
    throw err;
  }

  const missing = invitation.missingEmailId
    ? await MissingEmail.findOne({ missingEmailId: invitation.missingEmailId }).lean()
    : await MissingEmail.findOne({ handle: safeLower(invitation.handle || "") }).lean();

  if (!missing?.email) {
    const err = new Error("Recipient email not found for this invitation");
    err.statusCode = 404;
    throw err;
  }

  const recipientEmail = safeLower(missing.email);
  const influencerName =
    missing.youtube?.title ||
    (missing.handle ? safeStr(missing.handle).replace(/^@/, "") : recipientEmail.split("@")[0]);

  // Minimal influencer doc is required because EmailThread references influencer ObjectId
  let influencer = await Influencer.findOne({ email: recipientEmail });
  if (!influencer) {
    influencer = await Influencer.create({ email: recipientEmail, name: influencerName, otpVerified: false });
  }

  return { influencer, influencerName, recipientEmail };
}

// ===============================
// Campaign invitation build helpers
// ===============================
function insertCustomBodyIntoTemplate({ templateHtml, customBody }) {
  const custom = safeStr(customBody).trim();
  if (!custom) return templateHtml;

  const customHtmlBlock = `<p>${custom
    .split("\n")
    .map((line) => safeStr(line).trim())
    .join("<br/>")}</p><br/>`;

  const marker =
    '<h3 style="margin-top:24px;margin-bottom:8px;font-size:16px;color:#111827;">Campaign Details</h3>';

  if (templateHtml.includes(marker)) return templateHtml.replace(marker, `${customHtmlBlock}${marker}`);

  return `${customHtmlBlock}${templateHtml}`;
}

// ===============================
// Internal: send campaign invitation
// ===============================
async function sendCampaignInvitationInternal(payload = {}) {
  const {
    brandId,
    campaignId,
    influencerId,
    invitationId,
    campaignLink,
    compensation,
    deliverables,
    additionalNotes,
    subject: customSubject,
    body: customBody,
    attachments,
    _request,
  } = payload;

  if (!brandId) {
    const err = new Error("brandId is required.");
    err.statusCode = 400;
    throw err;
  }

  if (!influencerId && !invitationId) {
    const err = new Error("Either influencerId or invitationId is required.");
    err.statusCode = 400;
    throw err;
  }

  const brand = await findBrandByIdOrBrandId(brandId);
  if (!brand) {
    const err = new Error("Brand not found");
    err.statusCode = 404;
    throw err;
  }

  const { influencer, influencerName, recipientEmail } = await resolveInfluencerAndEmail({
    influencerId,
    invitationId,
    brand,
  });

  // Create / reuse thread + enforce policy
  const thread = await getOrCreateThread({
    brand,
    influencer,
    createdBy: "brand",
    subject: customSubject || undefined,
  });

  await enforceBrandPolicyOrThrow(thread._id);

  // Build email content
  let subject = safeStr(customSubject).trim();
  let htmlBody = "";
  let textBody = "";

  if (campaignId) {
    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) {
      const err = new Error("Campaign not found");
      err.statusCode = 404;
      throw err;
    }

    const brandName = brand.name;

    const campaignTitle =
      campaign.productOrServiceName || campaign.campaignType || campaign.brandName || "Our Campaign";
    const campaignObjective = campaign.goal || "";

    const defaultDeliverables =
      Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length
        ? campaign.creativeBrief.join(", ")
        : campaign.creativeBriefText || "Content deliverables to be discussed with you.";

    const finalDeliverables = deliverables || defaultDeliverables;
    const finalCompensation =
      compensation || "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) => d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes = additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = safeStr(process.env.CAMPAIGN_BASE_URL || "");
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : "#");

    const template = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    subject = subject || template.subject;

    if (safeStr(customBody).trim()) {
      htmlBody = insertCustomBodyIntoTemplate({ templateHtml: template.htmlBody, customBody });
      textBody = `${safeStr(customBody).trim()}\n\n${template.textBody}`;
    } else {
      htmlBody = template.htmlBody;
      textBody = template.textBody;
    }
  } else {
    subject = subject || `Collaboration opportunity with ${brand.name}`;

    if (safeStr(customBody).trim()) {
      textBody = safeStr(customBody).trim();
      htmlBody = buildStandardHtml(textBody);
    } else {
      const lines = [];
      lines.push(`Hi ${influencerName || "there"},`);
      lines.push("");
      lines.push(`${brand.name} would love to explore a collaboration with you on upcoming content.`);
      lines.push("");
      lines.push("If this sounds interesting, just hit reply and we can go over the details together.");
      lines.push("");
      lines.push("Best,");
      lines.push(`${brand.name} team`);
      textBody = lines.join("\n");
      htmlBody = buildStandardHtml(textBody);
    }
  }

  // Attachments -> GridFS (optional)
  const safeAttachments = normalizeAttachments(attachments);

  const uploadedFiles = await uploadEmailAttachmentsToGridFS({
    req: _request,
    safeAttachments,
    metadata: {
      kind: "email-attachment",
      brandId: brand.brandId || String(brand._id),
      influencerId: influencer.influencerId || String(influencer._id),
      invitationId: invitationId || null,
      campaignId: campaignId || null,
      direction: "brand_to_influencer",
      context: "campaign-invitation",
    },
  });

  const sesAttachments = safeAttachments.length
    ? safeAttachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        contentBase64: att.contentBase64,
        size: att.size,
      }))
    : undefined;

  // Send
  const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
  const replyTo = thread.brandAliasEmail; // relay address for replies
  const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;

  const sesResult = await sendViaSES({
    fromAlias: fromAliasPretty,
    fromName,
    toRealEmail: recipientEmail,
    subject,
    htmlBody,
    textBody,
    replyTo,
    attachments: sesAttachments,
  });

  // Save message
  const attachmentMeta = uploadedFiles.map((file) => ({
    filename: file.originalName || file.filename,
    contentType: file.mimeType,
    size: file.size,
    storageKey: String(file.id),
    url: file.url,
  }));

  const messageDoc = await EmailMessage.create({
    thread: thread._id,
    direction: "brand_to_influencer",

    fromUser: brand._id,
    fromUserModel: "Brand",

    fromAliasEmail: fromAliasPretty,
    fromProxyEmail: thread.brandAliasEmail,
    fromRealEmail: brand.email, // keep internal
    toRealEmail: recipientEmail, // keep internal
    toProxyEmail: thread.influencerAliasEmail,

    subject,
    htmlBody,
    textBody,

    template: null,
    attachments: attachmentMeta,
    sentAt: new Date(),
    messageId: sesResult?.MessageId || undefined,
  });

  thread.lastMessageAt = messageDoc.createdAt;
  thread.lastMessageDirection = "brand_to_influencer";
  thread.lastMessageSnippet = safeStr(textBody).slice(0, 200);
  await thread.save();

  return {
    success: true,
    threadId: thread._id,
    messageId: messageDoc._id,
    recipientEmail,
    brandAliasEmail: thread.brandAliasEmail,
    brandDisplayAlias: thread.brandDisplayAlias,
    influencerDisplayAlias: thread.influencerDisplayAlias,
    subject,
    campaignId: campaignId || null,
  };
}

// Export internal helper (if you use it elsewhere)
const _sendCampaignInvitationInternal = sendCampaignInvitationInternal;

// ===============================
// Controllers
// ===============================

// GET /api/email/templates/:key?brandId=...&influencerId=...
async function getTemplateByKey(req, res) {
  try {
    const { key } = req.params;
    const { brandId, influencerId } = req.query;

    const template = await EmailTemplate.findOne({ key }).lean();
    if (!template) return res.status(404).json({ error: "Template not found" });

    let brandName = "";
    let influencerName = "";

    if (brandId) {
      const b = await findBrandByIdOrBrandId(brandId);
      if (b) brandName = b.name;
    }
    if (influencerId) {
      const i = await findInfluencerByIdOrInfluencerId(influencerId);
      if (i) influencerName = i.name || "";
    }

    const ctx = { brandName, influencerName };

    return res.status(200).json({
      templateId: template._id,
      key: template.key,
      name: template.name,
      subject: renderTemplateString(template.subject, ctx),
      htmlBody: renderTemplateString(template.htmlBody, ctx),
      textBody: renderTemplateString(template.textBody || "", ctx),
    });
  } catch (err) {
    console.error("getTemplateByKey error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/brand-to-influencer
async function sendBrandToInfluencer(req, res) {
  try {
    const { brandId, influencerId, subject, body, attachments } = req.body;
    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({ error: "brandId, influencerId, subject and body are required." });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await getOrCreateThread({ brand, influencer, createdBy: "brand", subject });
    await enforceBrandPolicyOrThrow(thread._id);

    const safeAttachments = normalizeAttachments(attachments);

    const uploadedFiles = await uploadEmailAttachmentsToGridFS({
      req,
      safeAttachments,
      metadata: {
        kind: "email-attachment",
        brandId: brand.brandId || String(brand._id),
        influencerId: influencer.influencerId || String(influencer._id),
        direction: "brand_to_influencer",
        context: "brand-to-influencer",
      },
    });

    const sesAttachments = safeAttachments.length
      ? safeAttachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          contentBase64: a.contentBase64,
          size: a.size,
        }))
      : undefined;

    const fromAlias = thread.brandDisplayAlias || thread.brandAliasEmail;
    const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;

    const sesResult = await sendViaSES({
      fromAlias,
      fromName,
      toRealEmail: influencer.email,
      subject,
      htmlBody: buildStandardHtml(body),
      textBody: body,
      replyTo: thread.brandAliasEmail,
      attachments: sesAttachments,
    });

    const attachmentMeta = uploadedFiles.map((f) => ({
      filename: f.originalName || f.filename,
      contentType: f.mimeType,
      size: f.size,
      storageKey: String(f.id),
      url: f.url,
    }));

    const msg = await EmailMessage.create({
      thread: thread._id,
      direction: "brand_to_influencer",
      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.brandAliasEmail,
      toProxyEmail: thread.influencerAliasEmail,
      subject,
      htmlBody: buildStandardHtml(body),
      textBody: body,
      attachments: attachmentMeta,
      sentAt: new Date(),
      messageId: sesResult?.MessageId,
    });

    thread.lastMessageAt = msg.createdAt;
    thread.lastMessageDirection = "brand_to_influencer";
    thread.lastMessageSnippet = safeStr(body).slice(0, 200);
    await thread.save();

    return res.status(200).json({ success: true, threadId: String(thread._id), messageId: String(msg._id) });
  } catch (err) {
    console.error("sendBrandToInfluencer error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
      code: err.code,
      meta: err.meta,
    });
  }
}

// POST /api/email/influencer-to-brand
async function sendInfluencerToBrand(req, res) {
  try {
    const { brandId, influencerId, subject, body, attachments } = req.body;
    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({ error: "brandId, influencerId, subject and body are required." });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await getOrCreateThread({ brand, influencer, createdBy: "influencer", subject });

    const safeAttachments = normalizeAttachments(attachments);

    const uploadedFiles = await uploadEmailAttachmentsToGridFS({
      req,
      safeAttachments,
      metadata: {
        kind: "email-attachment",
        brandId: brand.brandId || String(brand._id),
        influencerId: influencer.influencerId || String(influencer._id),
        direction: "influencer_to_brand",
        context: "influencer-to-brand",
      },
    });

    const sesAttachments = safeAttachments.length
      ? safeAttachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          contentBase64: a.contentBase64,
          size: a.size,
        }))
      : undefined;

    const fromAlias = thread.influencerDisplayAlias || thread.influencerAliasEmail;
    const fromName = `${influencer.name || "Influencer"} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;

    const sesResult = await sendViaSES({
      fromAlias,
      fromName,
      toRealEmail: brand.email,
      subject,
      htmlBody: buildStandardHtml(body),
      textBody: body,
      replyTo: thread.influencerAliasEmail,
      attachments: sesAttachments,
    });

    const attachmentMeta = uploadedFiles.map((f) => ({
      filename: f.originalName || f.filename,
      contentType: f.mimeType,
      size: f.size,
      storageKey: String(f.id),
      url: f.url,
    }));

    const msg = await EmailMessage.create({
      thread: thread._id,
      direction: "influencer_to_brand",
      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.influencerAliasEmail,
      toProxyEmail: thread.brandAliasEmail,
      subject,
      htmlBody: buildStandardHtml(body),
      textBody: body,
      attachments: attachmentMeta,
      sentAt: new Date(),
      messageId: sesResult?.MessageId,
    });

    thread.lastMessageAt = msg.createdAt;
    thread.lastMessageDirection = "influencer_to_brand";
    thread.lastMessageSnippet = safeStr(body).slice(0, 200);
    await thread.save();

    return res.status(200).json({ success: true, threadId: String(thread._id), messageId: String(msg._id) });
  } catch (err) {
    console.error("sendInfluencerToBrand error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
}

// GET /api/email/brand/contacts?brandId=...
// invited + applied + conversation (no aggregation pipeline required)
async function getBrandContacts(req, res) {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: "brandId query param is required." });

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const brandKey = brand.brandId || String(brand._id);

    const map = new Map();

    const upsert = (key, patch) => {
      const prev =
        map.get(key) ||
        ({
          id: key,
          influencerId: null,
          invitationId: null,
          name: "Influencer",
          displayAlias: `influencer@${getRelayDomain()}`,

          threadId: null,
          lastMessageAt: null,
          lastMessageSnippet: "",

          flags: { invited: false, applied: false, conversation: false },
          invitation: null,
          appliedCampaigns: [],
        });

      map.set(key, {
        ...prev,
        ...patch,
        flags: { ...prev.flags, ...(patch.flags || {}) },
        appliedCampaigns: patch.appliedCampaigns ? patch.appliedCampaigns : prev.appliedCampaigns,
      });
    };

    // 1) Conversations (threads) — SAFE query, no CastError
    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "_id influencerId name otpVerified")
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(500)
      .lean();

    for (const t of threads) {
      const inf = t.influencer || null;
      const influencerId = inf?.influencerId ? String(inf.influencerId) : null;

      // prefer influencerId-based key, fallback to mongo id
      const key = influencerId ? `inf:${influencerId}` : `doc:${String(inf?._id || t.influencer)}`;

      upsert(key, {
        influencerId,
        name: inf?.name || t?.influencerSnapshot?.name || "Influencer",
        displayAlias: computeInfluencerDisplayAlias(inf),
        threadId: String(t._id),
        lastMessageAt: t.lastMessageAt || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        flags: { conversation: true },
      });
    }

    // 2) Applied (brand campaigns -> applications)
    const campaigns = await Campaign.find({ brandId: brandKey, isDraft: 0 })
      .select({ campaignsId: 1, productOrServiceName: 1, campaignType: 1, brandName: 1 })
      .lean();

    const campaignTitleById = new Map(
      campaigns.map((c) => [
        String(c.campaignsId),
        c.productOrServiceName || c.campaignType || c.brandName || "Campaign",
      ])
    );

    const campaignIds = campaigns.map((c) => c.campaignsId).filter(Boolean);

    if (campaignIds.length) {
      const appDocs = await CampaignApplication.find({ campaignId: { $in: campaignIds } }).lean();

      const appliedByInfluencer = new Map(); // influencerId -> list
      const add = (influencerId, campaignId, bucket) => {
        if (!influencerId) return;
        const k = String(influencerId);
        const arr = appliedByInfluencer.get(k) || [];
        arr.push({
          campaignId: String(campaignId),
          title: campaignTitleById.get(String(campaignId)) || "Campaign",
          bucket, // applicants | approved
        });
        appliedByInfluencer.set(k, arr);
      };

      for (const doc of appDocs) {
        const cid = doc.campaignId;
        (doc.applicants || []).forEach((a) => add(a.influencerId, cid, "applicants"));
        (doc.approved || []).forEach((a) => add(a.influencerId, cid, "approved"));
      }

      const influencerIds = [...appliedByInfluencer.keys()];
      if (influencerIds.length) {
        const influencers = await Influencer.find({ influencerId: { $in: influencerIds } })
          .select({ influencerId: 1, name: 1, otpVerified: 1 })
          .lean();

        const infById = new Map(influencers.map((i) => [String(i.influencerId), i]));

        for (const iid of influencerIds) {
          const inf = infById.get(String(iid));
          const key = `inf:${String(iid)}`;

          upsert(key, {
            influencerId: String(iid),
            name: inf?.name || "Influencer",
            displayAlias: computeInfluencerDisplayAlias(inf),
            appliedCampaigns: appliedByInfluencer.get(String(iid)) || [],
            flags: { applied: true },
          });
        }
      }
    }

    // 3) Invited (invitations)
    const invitations = await Invitation.find({ brandId: brandKey })
      .select({ invitationId: 1, handle: 1, platform: 1, status: 1, campaignId: 1 })
      .lean();

    for (const inv of invitations) {
      const key = `inv:${String(inv.invitationId)}`;
      upsert(key, {
        invitationId: String(inv.invitationId),
        name: inv.handle ? safeStr(inv.handle).replace(/^@/, "") : "Influencer",
        invitation: {
          invitationId: String(inv.invitationId),
          handle: inv.handle || null,
          platform: inv.platform || null,
          status: inv.status || null,
          campaignId: inv.campaignId || null,
        },
        flags: { invited: true },
      });
    }

    // sort: conversation > applied > invited, then lastMessageAt
    const list = [...map.values()].sort((a, b) => {
      const score = (x) => (x.flags.conversation ? 3 : 0) + (x.flags.applied ? 2 : 0) + (x.flags.invited ? 1 : 0);
      const s = score(b) - score(a);
      if (s !== 0) return s;

      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    });

    return res.status(200).json({
      brand: { brandId: brandKey, name: brand.name },
      influencers: list,
    });
  } catch (err) {
    console.error("getBrandContacts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/brand/inbox { brandId, limit }
async function getBrandInbox(req, res) {
  try {
    const brandId = req.body?.brandId || req.query?.brandId;
    const limit = Math.max(1, Math.min(Number(req.body?.limit || req.query?.limit || 20), 200));

    if (!brandId) return res.status(400).json({ error: "brandId is required." });

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const brandKey = brand.brandId || String(brand._id);

    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "influencerId name otpVerified")
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const threadIds = threads.map((t) => t._id);

    const messages = await EmailMessage.find({ thread: { $in: threadIds } })
      .select({
        thread: 1,
        direction: 1,
        createdAt: 1,
        sentAt: 1,
        receivedAt: 1,
        subject: 1,
        textBody: 1,
        htmlBody: 1,
        attachments: 1,
      })
      .sort({ createdAt: 1 })
      .lean();

    const msgsByThread = new Map();
    for (const m of messages) {
      const k = String(m.thread);
      const arr = msgsByThread.get(k) || [];
      arr.push({
        id: String(m._id),
        direction: m.direction,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        subject: m.subject || "",
        textBody: m.textBody || "",
        htmlBody: m.htmlBody || "",
        attachments: m.attachments || [],
      });
      msgsByThread.set(k, arr);
    }

    const conversations = threads.map((t) => {
      const inf = t.influencer || null;
      const influencerName = inf?.name || t.influencerSnapshot?.name || "Influencer";

      return {
        threadId: String(t._id),
        influencer: { influencerId: inf?.influencerId || null, name: influencerName },
        subject: t.subject || "",
        snippet: t.lastMessageSnippet || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        status: t.status || "active",
        messages: msgsByThread.get(String(t._id)) || [],
      };
    });

    return res.status(200).json({
      brand: { brandId: brandKey, name: brand.name },
      conversations,
    });
  } catch (err) {
    console.error("getBrandInbox error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/threads/brand/:brandId
async function getThreadsForBrand(req, res) {
  try {
    const brand = await findBrandByIdOrBrandId(req.params.brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const brandKey = brand.brandId || String(brand._id);

    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "name influencerId otpVerified")
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      brand: { brandId: brandKey, name: brand.name },
      threads: threads.map((t) => ({
        threadId: String(t._id),
        subject: t.subject || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        influencer: {
          influencerId: t.influencer?.influencerId || null,
          name: t.influencer?.name || t.influencerSnapshot?.name || "Influencer",
        },
      })),
    });
  } catch (err) {
    console.error("getThreadsForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/threads/influencer/:influencerId
async function getThreadsForInfluencer(req, res) {
  try {
    const influencer = await findInfluencerByIdOrInfluencerId(req.params.influencerId);
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate("brand", "name brandId logoUrl")
      .sort({ lastMessageAt: -1 })
      .lean();

    return res.status(200).json({ threads });
  } catch (err) {
    console.error("getThreadsForInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/messages/:threadId
async function getMessagesForThread(req, res) {
  try {
    const { threadId } = req.params;

    const thread = await EmailThread.findById(threadId).lean();
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const messages = await EmailMessage.find({ thread: threadId })
      .select({
        direction: 1,
        createdAt: 1,
        sentAt: 1,
        receivedAt: 1,
        subject: 1,
        textBody: 1,
        htmlBody: 1,
        attachments: 1,
        fromProxyEmail: 1,
        toProxyEmail: 1,
        fromAliasEmail: 1,
      })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      messages: messages.map((m) => ({
        id: String(m._id),
        direction: m.direction,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        subject: m.subject || "",
        textBody: m.textBody || "",
        htmlBody: m.htmlBody || "",
        fromAliasEmail: m.fromAliasEmail,
        fromProxyEmail: m.fromProxyEmail,
        toProxyEmail: m.toProxyEmail,
        attachments: m.attachments || [],
      })),
    });
  } catch (err) {
    console.error("getMessagesForThread error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/campaign-invitation
async function sendCampaignInvitation(req, res) {
  try {
    const result = await sendCampaignInvitationInternal({ ...req.body, _request: req });
    return res.status(200).json(result);
  } catch (err) {
    console.error("sendCampaignInvitation error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
      code: err.code || undefined,
      meta: err.meta || undefined,
    });
  }
}

// POST /api/email/campaign-invitation/preview
async function getCampaignInvitationPreview(req, res) {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      invitationId,
      campaignLink,
      compensation,
      deliverables,
      additionalNotes,
    } = req.body;

    if (!brandId || !campaignId) return res.status(400).json({ error: "brandId and campaignId are required." });
    if (!influencerId && !invitationId) return res.status(400).json({ error: "Either influencerId or invitationId is required." });

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { influencer, influencerName, recipientEmail } = await resolveInfluencerAndEmail({
      influencerId,
      invitationId,
      brand,
    });

    const brandName = brand.name;
    const campaignTitle =
      campaign.productOrServiceName || campaign.campaignType || campaign.brandName || "Our Campaign";
    const campaignObjective = campaign.goal || "";

    const defaultDeliverables =
      Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length
        ? campaign.creativeBrief.join(", ")
        : campaign.creativeBriefText || "Content deliverables to be discussed with you.";

    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation || "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) => d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes = additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = safeStr(process.env.CAMPAIGN_BASE_URL || "");
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : "#");

    const templateResult = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    return res.status(200).json({
      success: true,
      subject: templateResult.subject,
      htmlBody: templateResult.htmlBody,
      textBody: templateResult.textBody,
      meta: {
        brandName,
        influencerName,
        campaignTitle,
        campaignObjective,
        deliverables: finalDeliverables,
        compensation: finalCompensation,
        timeline: timelineText,
        additionalNotes: notes,
        campaignLink: link,
        recipientEmail,
        influencerId: influencer?.influencerId || influencer?._id,
      },
    });
  } catch (err) {
    console.error("getCampaignInvitationPreview error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
}

// POST /api/email/invitation  (your flow)
async function handleEmailInvitation(req, res) {
  try {
    const rawEmail = safeLower(req.body?.email || "");
    const rawBrandId = safeStr(req.body?.brandId || "").trim();
    const rawCampaignId = safeStr(req.body?.campaignId || "").trim();
    const rawHandle = safeStr(req.body?.handle || "").trim();
    const rawPlatform = safeStr(req.body?.platform || "").trim();

    const {
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
    } = req.body;

    if (!rawEmail) return res.status(400).json({ status: "error", message: "email is required" });
    if (!rawBrandId) return res.status(400).json({ status: "error", message: "brandId is required" });

    const brand = await Brand.findOne({ brandId: rawBrandId }, "brandId name email").lean();
    if (!brand) return res.status(404).json({ status: "error", message: "Brand not found for given brandId" });

    const brandName = brand.name || rawBrandId;

    const influencer = await Influencer.findOne({ email: rawEmail }).lean();

    // A) Existing verified influencer => send directly
    if (influencer?.influencerId && influencer?.otpVerified) {
      const sendResult = await sendCampaignInvitationInternal({
        brandId: rawBrandId,
        campaignId: rawCampaignId || undefined,
        influencerId: influencer.influencerId,
        compensation,
        deliverables,
        additionalNotes,
        subject: customSubject,
        body: customBody,
        attachments,
        _request: req,
      });

      return res.json({
        status: "success",
        message: "Existing influencer found, invitation email sent.",
        isExistingInfluencer: true,
        influencerId: influencer.influencerId,
        influencerName: influencer.name || influencer.fullname || influencer.email || rawEmail,
        brandName,
        emailSent: true,
        emailMeta: {
          recipientEmail: sendResult.recipientEmail,
          threadId: String(sendResult.threadId),
          messageId: String(sendResult.messageId),
          subject: sendResult.subject,
          campaignId: sendResult.campaignId,
        },
      });
    }

    // B) Not verified => handle/platform required
    if (!rawHandle || !rawPlatform) {
      return res.status(400).json({
        status: "error",
        message: "handle and platform are required when influencer is not signed up",
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: 'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!platform) {
      return res.status(400).json({
        status: "error",
        message: "Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)",
      });
    }

    // Ensure MissingEmail
    let missing = await MissingEmail.findOne({ email: rawEmail });
    if (!missing) missing = await MissingEmail.findOne({ handle });

    if (!missing) {
      missing = await MissingEmail.create({ email: rawEmail, handle, platform, brandId: rawBrandId });
    } else {
      let changed = false;
      if (rawEmail && rawEmail !== missing.email) (missing.email = rawEmail), (changed = true);
      if (handle && handle !== missing.handle) (missing.handle = handle), (changed = true);
      if (platform && platform !== missing.platform) (missing.platform = platform), (changed = true);
      if (changed) await missing.save();
    }

    // Find/create Invitation
    let invitation = await Invitation.findOne({ brandId: rawBrandId, handle, platform });
    let isNewInvitation = false;

    if (!invitation) {
      invitation = await Invitation.create({
        brandId: rawBrandId,
        handle,
        platform,
        campaignId: rawCampaignId || null,
        status: "available",
        missingEmailId: missing.missingEmailId,
      });
      isNewInvitation = true;
    } else {
      let saveNeeded = false;
      if (rawCampaignId && invitation.campaignId !== rawCampaignId) {
        invitation.campaignId = rawCampaignId;
        saveNeeded = true;
      }
      if (missing.missingEmailId && invitation.missingEmailId !== missing.missingEmailId) {
        invitation.missingEmailId = missing.missingEmailId;
        saveNeeded = true;
      }
      if (saveNeeded) await invitation.save();
    }

    const sendResult = await sendCampaignInvitationInternal({
      brandId: rawBrandId,
      campaignId: rawCampaignId || undefined,
      invitationId: invitation.invitationId,
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
      _request: req,
    });

    return res.json({
      status: "success",
      message: "Email invitation created and sent to this creator.",
      isExistingInfluencer: false,
      brandName,
      invitationId: invitation.invitationId,
      emailSent: true,
      emailMeta: {
        recipientEmail: sendResult.recipientEmail,
        threadId: String(sendResult.threadId),
        messageId: String(sendResult.messageId),
        subject: sendResult.subject,
        campaignId: sendResult.campaignId,
      },
      isNewInvitation,
    });
  } catch (err) {
    console.error("Error in handleEmailInvitation:", err);
    return res.status(err.statusCode || 500).json({
      status: "error",
      message: err.message || "Internal server error",
      code: err.code,
      meta: err.meta,
    });
  }
}

// GET /api/email/conversations (current influencer)
async function getConversationsForCurrentInfluencer(req, res) {
  try {
    const auth = req.influencer;
    if (!auth || !auth.influencerId) return res.status(403).json({ error: "Forbidden" });

    const influencer = await Influencer.findOne({ influencerId: auth.influencerId }).lean();
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate("brand", "name brandId logoUrl")
      .sort({ lastMessageAt: -1 })
      .lean();

    const conversations = threads.map((t) => ({
      id: String(t._id),
      brand: {
        brandId: t.brand?.brandId || null,
        name: t.brand?.name || t.brandSnapshot?.name || "Brand",
        aliasEmail: t.brandAliasEmail,
        logoUrl: t.brand?.logoUrl || null,
      },
      subject: t.subject || t.lastMessageSnippet || "",
      lastMessageAt: t.lastMessageAt,
      lastMessageDirection: t.lastMessageDirection,
      lastMessageSnippet: t.lastMessageSnippet || "",
      influencerAliasEmail: t.influencerAliasEmail,
      // NOTE: we do NOT expose brand.email or influencerSnapshot.email
    }));

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error("getConversationsForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/conversations/:id (current influencer)
async function getConversationForCurrentInfluencer(req, res) {
  try {
    const auth = req.influencer;
    const { id: threadId } = req.params;

    if (!auth || !auth.influencerId) return res.status(403).json({ error: "Forbidden" });

    const influencer = await Influencer.findOne({ influencerId: auth.influencerId });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await EmailThread.findById(threadId)
      .populate("brand", "name brandId logoUrl")
      .populate("influencer", "name influencerId")
      .lean();

    if (!thread) return res.status(404).json({ error: "Conversation not found" });
    if (String(thread.influencer) !== String(influencer._id)) return res.status(403).json({ error: "Forbidden" });

    const messages = await EmailMessage.find({ thread: thread._id }).sort({ createdAt: 1 }).lean();

    const mappedMessages = messages.map((m) => ({
      id: String(m._id),
      direction: m.direction,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      subject: m.subject,
      htmlBody: m.htmlBody,
      textBody: m.textBody,
      // Only proxy addresses – no real emails
      fromAliasEmail: m.fromAliasEmail,
      fromProxyEmail: m.fromProxyEmail,
      toProxyEmail: m.toProxyEmail,
      attachments: m.attachments || [],
    }));

    return res.status(200).json({
      conversation: {
        id: String(thread._id),
        subject: thread.subject,
        brand: {
          brandId: thread.brand?.brandId || null,
          name: thread.brand?.name || thread.brandSnapshot?.name || "Brand",
          aliasEmail: thread.brandAliasEmail,
          logoUrl: thread.brand?.logoUrl || null,
        },
        influencer: {
          influencerId: thread.influencer?.influencerId || auth.influencerId,
          name: thread.influencer?.name || influencer.name,
          aliasEmail: thread.influencerAliasEmail,
        },
        lastMessageAt: thread.lastMessageAt,
        lastMessageDirection: thread.lastMessageDirection,
        messages: mappedMessages,
      },
    });
  } catch (err) {
    console.error("getConversationForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Optional: keep this for backward compatibility if routes still call it.
// GET => same as getBrandContacts, POST => same as getBrandInbox
async function getInfluencerEmailListForBrand(req, res) {
  try {
    if (req.method === "POST") return await getBrandInbox(req, res);
    return await getBrandContacts(req, res);
  } catch (err) {
    console.error("getInfluencerEmailListForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ===============================
// Exports
// ===============================
module.exports = {
  // templates
  getTemplateByKey,

  // send
  sendBrandToInfluencer,
  sendInfluencerToBrand,

  // brand UI
  getBrandContacts,
  getBrandInbox,

  // threads/messages
  getThreadsForBrand,
  getThreadsForInfluencer,
  getMessagesForThread,

  // campaign invitation
  sendCampaignInvitation,
  getCampaignInvitationPreview,
  handleEmailInvitation,

  // influencer app
  getConversationsForCurrentInfluencer,
  getConversationForCurrentInfluencer,

  // backwards compat
  getInfluencerEmailListForBrand,

  // internal helper (if used elsewhere)
  _sendCampaignInvitationInternal,
};
