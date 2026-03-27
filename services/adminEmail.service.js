// services/adminEmail.service.js
const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");

const AdminEmailThreadModel = require("../models/adminEmailThread");
const AdminEmailMessageModel = require("../models/adminEmailMessage");
const { AdminModel, ROLES } = require("../models/master");
const { sendEmail, uploadEmailRecordToS3 } = require("./emailService");
const { collabOpportunityBulkTemplate } = require("../template/collabOpportunityBulk");
const {
  cleanStr,
  cleanEmail,
  toObjectIdStrict,
  buildThreadReplyAddress,
  buildReferences,
} = require("../utils/emailThread.util");
const { InfluencerPipeline } = require("../models/influencerPipeline");
const { ensureCampaignAccess } = require("../utils/campaignAccess");
const {
  getActorAdmin,
  getActorScope,
  buildThreadScopeFilter,
  assertThreadScope,
  assertOwnerAssignable,
} = require("../utils/adminEmailAccess");
const { BrandOutreach } = require("../models/brandOutreach");

const region = process.env.AWS_REGION || "us-east-1";
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function parseRecipientsFromCsv(csvBuffer) {
  const text = csvBuffer.toString("utf-8");
  let rows = [];

  try {
    rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    rows = [];
  }

  const pick = (row, keys) => {
    for (const key of keys) {
      if (row?.[key] != null && String(row[key]).trim()) return String(row[key]).trim();
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
    const fallbackRows = parse(text, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
    });

    for (const row of fallbackRows) {
      const name = cleanStr(row?.[0]);
      const email = cleanStr(row?.[1]);
      if (!email) continue;
      recipients.push({ name, email });
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

function buildBrandOutreachTemplate({ brandName, replyToEmail, executiveName }) {
  const safeName = cleanStr(brandName) || "there";

  return {
    subject: "Partnership Opportunity",
    text: `Hi ${safeName},

We would love to explore a partnership opportunity with your brand.

If this sounds relevant, please reply to this email and we can discuss details.

Best,
${executiveName}

Reply here: ${replyToEmail}
`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <p>Hi ${safeName},</p>
        <p>We would love to explore a partnership opportunity with your brand.</p>
        <p>If this sounds relevant, please reply to this email and we can discuss details.</p>
        <p>Best,<br/>${executiveName}</p>
        <p><b>Reply here:</b> ${replyToEmail}</p>
      </div>
    `,
  };
}

function mapAdminRoleToThreadRole(role) {
  const allowedRoles = [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME, ROLES.BME];
  if (!allowedRoles.includes(role)) throw new Error("Unsupported admin role");
  return role;
}

function normalizeEmails(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(",");
  const seen = new Set();

  return arr
    .map((item) => cleanEmail(item))
    .filter((item) => item && isValidEmail(item))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

async function getAdminSender(adminId) {
  const execObj = toObjectIdStrict(adminId, "adminId");

  const admin = await AdminModel.findById(execObj)
    .select("name email proxyEmail proxyemail role status")
    .lean();

  if (!admin) throw new Error("Admin not found");

  const allowedRoles = [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME, ROLES.BME];
  if (!allowedRoles.includes(admin.role)) {
    throw new Error("Only super_admin, revenue_head, ime, or bme can send emails");
  }

  if (String(admin.status || "").trim().toLowerCase() !== "active") {
    throw new Error("Admin account is not active");
  }

  const from = cleanEmail(admin.proxyEmail || admin.proxyemail || admin.email);
  if (!from) throw new Error("Sender email missing for this admin");

  return {
    adminId: execObj,
    admin,
    from,
    executiveName: cleanStr(admin.name) || "Team CollabGlam",
  };
}

async function createOrGetThread({
  pipelineId = null,
  brandOutreachId = null,
  campaignId = null,
  executiveId,
  role,
  senderEmail,
  recipientEmail,
  subject,
  actorAdminId,
}) {
  let thread = null;

  if (pipelineId) {
    thread = await AdminEmailThreadModel.findOne({ pipelineId });
  } else if (brandOutreachId) {
    thread = await AdminEmailThreadModel.findOne({ brandOutreachId });
  } else {
    thread = await AdminEmailThreadModel.findOne({ executiveId, recipientEmail });
  }

  if (!thread) {
    thread = await AdminEmailThreadModel.create({
      pipelineId,
      brandOutreachId,
      campaignId,
      executiveId,
      role: mapAdminRoleToThreadRole(role),
      senderEmail,
      recipientEmail,
      replyToEmail: "temp@temp.local",
      subject,
      lastMessageAt: new Date(),
      lastMessageDirection: "OUTBOUND",
      lastActorAdminId: actorAdminId || executiveId,
      createdByAdminId: actorAdminId || executiveId,
      updatedByAdminId: actorAdminId || executiveId,
    });

    thread.replyToEmail = buildThreadReplyAddress(thread._id);
    await thread.save();
    return thread;
  }

  thread.executiveId = executiveId;
  thread.role = mapAdminRoleToThreadRole(role);
  thread.senderEmail = senderEmail;
  thread.recipientEmail = recipientEmail;
  thread.subject = subject || thread.subject;
  thread.pipelineId = pipelineId || thread.pipelineId || null;
  thread.brandOutreachId = brandOutreachId || thread.brandOutreachId || null;
  thread.campaignId = campaignId || thread.campaignId || null;
  thread.lastMessageAt = new Date();
  thread.lastMessageDirection = "OUTBOUND";
  thread.lastActorAdminId = actorAdminId || executiveId;
  thread.updatedByAdminId = actorAdminId || executiveId;

  if (!thread.createdByAdminId) {
    thread.createdByAdminId = actorAdminId || executiveId;
  }

  if (!thread.replyToEmail) {
    thread.replyToEmail = buildThreadReplyAddress(thread._id);
  }

  await thread.save();
  return thread;
}

async function saveOutboundAndSend({
  thread,
  to,
  from,
  cc = [],
  bcc = [],
  subject,
  text,
  html,
  executiveId,
  actorAdminId,
  meta = {},
}) {
  const lastMessage = await AdminEmailMessageModel.findOne({ threadId: thread._id })
    .sort({ createdAt: -1 })
    .lean();

  const references = lastMessage ? buildReferences(lastMessage) : [];

  const emailMessage = await AdminEmailMessageModel.create({
    threadId: thread._id,
    pipelineId: thread.pipelineId || null,
    brandOutreachId: thread.brandOutreachId || null,
    campaignId: thread.campaignId || null,
    actorAdminId: actorAdminId || executiveId,
    ownerAdminId: executiveId,
    direction: "OUTBOUND",
    subject,
    from,
    to: [to],
    cc,
    bcc,
    replyTo: [thread.replyToEmail],
    inReplyTo: lastMessage?.messageId || null,
    references,
    provider: "SES",
    providerStatus: "QUEUED",
    textPreview: text ? text.slice(0, 1000) : null,
    htmlPreview: html ? String(html).slice(0, 2000) : null,
    meta,
  });

  const emailTags = [
    { Name: "threadId", Value: String(thread._id) },
    { Name: "executiveId", Value: String(executiveId) },
    { Name: "actorAdminId", Value: String(actorAdminId || executiveId) },
    { Name: "source", Value: meta.source || "MANUAL" },
  ];

  if (thread.pipelineId) {
    emailTags.push({ Name: "pipelineId", Value: String(thread.pipelineId) });
  }

  if (thread.brandOutreachId) {
    emailTags.push({ Name: "brandOutreachId", Value: String(thread.brandOutreachId) });
  }

  if (thread.campaignId) {
    emailTags.push({ Name: "campaignId", Value: String(thread.campaignId) });
  }

  const { messageId } = await sendEmail({
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    from,
    replyTo: [thread.replyToEmail],
    configurationSetName: process.env.SES_CONFIGURATION_SET,
    emailTags,
  });

  let s3Key = null;
  try {
    s3Key = await uploadEmailRecordToS3({
      type: "OUTBOUND_EMAIL",
      provider: "SES",
      threadId: String(thread._id),
      emailMessageId: String(emailMessage._id),
      executiveId: String(executiveId),
      actorAdminId: String(actorAdminId || executiveId),
      pipelineId: thread.pipelineId ? String(thread.pipelineId) : null,
      brandOutreachId: thread.brandOutreachId ? String(thread.brandOutreachId) : null,
      campaignId: thread.campaignId ? String(thread.campaignId) : null,
      to,
      cc,
      bcc,
      from,
      replyTo: thread.replyToEmail,
      subject,
      text,
      html,
      sesMessageId: messageId || null,
      createdAt: new Date().toISOString(),
      meta,
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
        s3Bucket: process.env.EMAIL_ARCHIVE_BUCKET || null,
        s3Key: s3Key || null,
      },
    }
  );

  await AdminEmailThreadModel.updateOne(
    { _id: thread._id },
    {
      $set: {
        lastMessageAt: new Date(),
        lastMessageDirection: "OUTBOUND",
        lastActorAdminId: actorAdminId || executiveId,
        updatedByAdminId: actorAdminId || executiveId,
      },
    }
  );

  if (thread.pipelineId) {
    try {
      const outboundCount = await AdminEmailMessageModel.countDocuments({
        threadId: thread._id,
        direction: "OUTBOUND",
      });

      const pipelineUpdate = {
        updatedByAdmin: executiveId,
      };

      if (outboundCount >= 1) {
        pipelineUpdate.outreached = true;
        if (!pipelineUpdate.outreachDate) {
          pipelineUpdate.outreachDate = new Date();
        }
      }

      if (outboundCount === 2) {
        pipelineUpdate.followUp1SentAt = new Date();
      }

      if (outboundCount === 3) {
        pipelineUpdate.followUp2SentAt = new Date();
      }

      await InfluencerPipeline.updateOne(
        { _id: thread.pipelineId },
        { $set: pipelineUpdate }
      );
    } catch (error) {
      console.error("Pipeline update after email send failed:", error?.message || error);
    }
  }

  if (thread.brandOutreachId) {
    try {
      const outboundCount = await AdminEmailMessageModel.countDocuments({
        threadId: thread._id,
        direction: "OUTBOUND",
      });

      const brandUpdate = {
        updatedByAdmin: executiveId,
        dateLastContact: new Date(),
      };

      if (outboundCount >= 1) {
        brandUpdate.outreached = true;
      }

      if (outboundCount >= 2) {
        brandUpdate.followUp1 = true;
        brandUpdate.followUp1SentAt = new Date();
      }

      if (outboundCount >= 3) {
        brandUpdate.followUp2 = true;
        brandUpdate.followUp2SentAt = new Date();
      }

      if (outboundCount >= 4) {
        brandUpdate.followUp3 = true;
        brandUpdate.followUp3SentAt = new Date();
      }

      await BrandOutreach.updateOne(
        { _id: thread.brandOutreachId },
        { $set: brandUpdate }
      );
    } catch (error) {
      console.error("Brand outreach update after email send failed:", error?.message || error);
    }
  }

  return {
    threadId: String(thread._id),
    emailMessageId: String(emailMessage._id),
    sesMessageId: messageId || null,
    replyToEmail: thread.replyToEmail,
    s3Key,
  };
}

async function sendSelectedBrandOutreachEmailsService({
  actorAdminId,
  brandOutreachIds,
  subject,
  text,
  html,
  ownerAdminId = null,
}) {
  await getActorAdmin(actorAdminId);

  const targetOwnerId = ownerAdminId
    ? await assertOwnerAssignable(actorAdminId, ownerAdminId)
    : toObjectIdStrict(actorAdminId, "actorAdminId");

  const { adminId: execObj, admin, from, executiveName } = await getAdminSender(targetOwnerId);

  const validIds = Array.isArray(brandOutreachIds)
    ? brandOutreachIds.map((id) => cleanStr(id)).filter((id) => mongoose.Types.ObjectId.isValid(id))
    : [];

  if (!validIds.length) throw new Error("brandOutreachIds are required");

  const rows = await BrandOutreach.find({
    _id: { $in: validIds },
  }).lean();

  if (!rows.length) throw new Error("No valid brand outreach rows found");

  const finalSubject = cleanStr(subject) || "Partnership Opportunity";
  const results = [];

  for (const row of rows) {
    try {
      const to = cleanEmail(row.emailOfPerson);
      if (!to || !isValidEmail(to)) {
        results.push({
          brandOutreachId: String(row._id),
          email: row.emailOfPerson || "",
          name: row.brandName || "",
          success: false,
          error: "Valid email missing",
        });
        continue;
      }

      const recipientName = cleanStr(row.brandName) || "there";

      const thread = await createOrGetThread({
        brandOutreachId: row._id,
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        subject: finalSubject,
        actorAdminId,
      });

      let finalText = text;
      let finalHtml = html;
      let finalEmailSubject = finalSubject;

      if (!finalText && !finalHtml) {
        const templ = buildBrandOutreachTemplate({
          brandName: recipientName,
          replyToEmail: thread.replyToEmail,
          executiveName,
        });

        finalText = templ.text;
        finalHtml = templ.html;
        finalEmailSubject = templ.subject || finalSubject;
      }

      const sent = await saveOutboundAndSend({
        thread,
        to,
        from,
        subject: finalEmailSubject,
        text: finalText,
        html: finalHtml,
        executiveId: execObj,
        actorAdminId,
        meta: {
          source: "BRAND_OUTREACH_SELECTION",
          recipientName,
          role: admin.role,
          brandOutreachId: String(row._id),
        },
      });

      results.push({
        brandOutreachId: String(row._id),
        email: to,
        name: recipientName,
        success: true,
        ...sent,
      });
    } catch (error) {
      results.push({
        brandOutreachId: String(row._id),
        email: row.emailOfPerson || "",
        name: row.brandName || "",
        success: false,
        error: error?.message || "Failed",
      });
    }
  }

  return {
    total: results.length,
    sent: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

async function getBrandThreadConversationState({
  brandOutreachId = null,
  recipientEmail = null,
  actorAdminId,
}) {
  const email = cleanEmail(recipientEmail);

  const emptyState = {
    threadId: null,
    outboundCount: 0,
    outreachSentAt: null,
    followUp1SentAt: null,
    followUp2SentAt: null,
    followUp3SentAt: null,
    replyChecked: false,
    repliedAt: null,
    replyText: "",
  };

  const scope = await getActorScope(actorAdminId);

  let thread = null;

  if (brandOutreachId) {
    const rowObj = toObjectIdStrict(brandOutreachId, "brandOutreachId");

    const filter = { brandOutreachId: rowObj };
    if (scope.adminIds !== null) {
      filter.executiveId = { $in: scope.adminIds };
    }

    thread = await AdminEmailThreadModel.findOne(filter)
      .sort({ lastMessageAt: -1 })
      .lean();
  }

  if (!thread && email) {
    const filter = { recipientEmail: email };
    if (scope.adminIds !== null) {
      filter.executiveId = { $in: scope.adminIds };
    }

    thread = await AdminEmailThreadModel.findOne(filter)
      .sort({ lastMessageAt: -1 })
      .lean();
  }

  if (!thread) return emptyState;

  const messages = await AdminEmailMessageModel.find({ threadId: thread._id })
    .sort({ createdAt: 1 })
    .lean();

  const outbound = messages.filter((m) => m.direction === "OUTBOUND");
  const inbound = messages.filter((m) => m.direction === "INBOUND");
  const firstInbound = inbound[0] || null;

  return {
    threadId: String(thread._id),
    outboundCount: outbound.length,
    outreachSentAt: outbound[0]?.createdAt || null,
    followUp1SentAt: outbound[1]?.createdAt || null,
    followUp2SentAt: outbound[2]?.createdAt || null,
    followUp3SentAt: outbound[3]?.createdAt || null,
    replyChecked: !!firstInbound,
    repliedAt: firstInbound?.createdAt || null,
    replyText: cleanStr(firstInbound?.textPreview || firstInbound?.htmlPreview),
  };
}

async function getBrandOutreachRecipientsForComposeService({
  actorAdminId,
  brandOutreachIds,
}) {
  await getActorAdmin(actorAdminId);

  const validIds = Array.isArray(brandOutreachIds)
    ? brandOutreachIds.map((id) => cleanStr(id)).filter((id) => mongoose.Types.ObjectId.isValid(id))
    : [];

  if (!validIds.length) throw new Error("brandOutreachIds are required");

  const rows = await BrandOutreach.find({
    _id: { $in: validIds },
  }).lean();

  const rowObjectIds = rows.map((row) => row._id);
  const threads = await AdminEmailThreadModel.find({
    brandOutreachId: { $in: rowObjectIds },
  })
    .select("brandOutreachId replyToEmail _id")
    .lean();

  const threadByRowId = new Map(
    threads.map((item) => [String(item.brandOutreachId), item])
  );

  return rows
    .filter((row) => cleanEmail(row.emailOfPerson))
    .map((row) => {
      const thread = threadByRowId.get(String(row._id));
      return {
        brandOutreachId: String(row._id),
        name: cleanStr(row.brandName) || cleanStr(row.emailOfPerson),
        email: cleanEmail(row.emailOfPerson),
        website: cleanStr(row.website),
        status: row.moveToNetwork ? "network" : "outreach",
        threadId: thread?._id ? String(thread._id) : null,
        replyToEmail: thread?.replyToEmail || null,
      };
    });
}

async function getMailboxScopeService({ actorAdminId }) {
  const scope = await getActorScope(actorAdminId);
  return {
    actor: scope.actor,
    scope: {
      type: scope.type,
      visibleAdminIds:
        scope.adminIds === null ? null : scope.adminIds.map((id) => String(id)),
      canCompose: scope.canCompose,
      canReply: scope.canReply,
      canEditThread: scope.canEditThread,
    },
  };
}

async function listThreads({ actorAdminId, page = 1, limit = 20, search = "", status = "", ownerAdminId = "" }) {
  const scope = await getActorScope(actorAdminId);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const filter = buildThreadScopeFilter(scope);

  if (status && ["ACTIVE", "ARCHIVED", "CLOSED"].includes(String(status).toUpperCase())) {
    filter.status = String(status).toUpperCase();
  }

  if (ownerAdminId && mongoose.Types.ObjectId.isValid(ownerAdminId)) {
    const ownerObj = toObjectIdStrict(ownerAdminId, "ownerAdminId");
    if (scope.adminIds !== null && !scope.adminIds.some((id) => String(id) === String(ownerObj))) {
      throw new Error("You are not allowed to filter this owner");
    }
    filter.executiveId = ownerObj;
  }

  if (cleanStr(search)) {
    const regex = new RegExp(cleanStr(search), "i");
    filter.$or = [
      { subject: regex },
      { recipientEmail: regex },
      { senderEmail: regex },
      { replyToEmail: regex },
    ];
  }

  const [items, total] = await Promise.all([
    AdminEmailThreadModel.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate("executiveId", "name email proxyEmail role parentAdmin rootAdmin")
      .populate("lastActorAdminId", "name email role")
      .lean(),
    AdminEmailThreadModel.countDocuments(filter),
  ]);

  return {
    page: safePage,
    limit: safeLimit,
    total,
    items,
  };
}

async function getThreadMessages({ threadId, actorAdminId }) {
  const tid = toObjectIdStrict(threadId, "threadId");

  // first fetch raw thread for permission check
  const rawThread = await AdminEmailThreadModel.findById(tid).lean();
  if (!rawThread) throw new Error("Thread not found");

  await assertThreadScope(rawThread, actorAdminId);

  // then fetch populated thread for response
  const thread = await AdminEmailThreadModel.findById(tid)
    .populate("executiveId", "name email proxyEmail role parentAdmin rootAdmin")
    .populate("lastActorAdminId", "name email role")
    .lean();

  const messages = await AdminEmailMessageModel.find({ threadId: tid })
    .sort({ createdAt: 1 })
    .populate("actorAdminId", "name email role")
    .populate("ownerAdminId", "name email proxyEmail role")
    .lean();

  return { thread, messages };
}

async function replyToThread({ threadId, actorAdminId, subject, text, html, cc = [], bcc = [] }) {
  const tid = toObjectIdStrict(threadId, "threadId");

  const thread = await AdminEmailThreadModel.findById(tid).lean();
  if (!thread) throw new Error("Thread not found");

  await assertThreadScope(thread, actorAdminId);

  const finalSubject = cleanStr(subject) || thread.subject;
  const to = thread.recipientEmail;

  return saveOutboundAndSend({
    thread,
    to,
    from: thread.senderEmail,
    cc: normalizeEmails(cc),
    bcc: normalizeEmails(bcc),
    subject: finalSubject,
    text,
    html,
    executiveId: thread.executiveId,
    actorAdminId,
    meta: {
      source: "THREAD_REPLY",
      repliedByAdminId: String(actorAdminId),
    },
  });
}

async function updateThreadService({ threadId, actorAdminId, subject, status, ownerAdminId }) {
  const tid = toObjectIdStrict(threadId, "threadId");
  const thread = await AdminEmailThreadModel.findById(tid);
  if (!thread) throw new Error("Thread not found");

  await assertThreadScope(thread, actorAdminId);

  if (subject != null) thread.subject = cleanStr(subject) || thread.subject;
  if (status != null) {
    const normalizedStatus = String(status).toUpperCase();
    if (!["ACTIVE", "ARCHIVED", "CLOSED"].includes(normalizedStatus)) {
      throw new Error("Invalid status");
    }
    thread.status = normalizedStatus;
  }

  if (ownerAdminId) {
    const nextOwnerId = await assertOwnerAssignable(actorAdminId, ownerAdminId);
    const sender = await getAdminSender(nextOwnerId);
    thread.executiveId = sender.adminId;
    thread.role = mapAdminRoleToThreadRole(sender.admin.role);
    thread.senderEmail = sender.from;
  }

  thread.updatedByAdminId = actorAdminId;
  thread.lastActorAdminId = actorAdminId;
  await thread.save();

  return AdminEmailThreadModel.findById(thread._id)
    .populate("executiveId", "name email proxyEmail role parentAdmin rootAdmin")
    .populate("lastActorAdminId", "name email role")
    .lean();
}

async function composeManualEmailService({
  actorAdminId,
  ownerAdminId,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
}) {
  const targetOwnerId = ownerAdminId
    ? await assertOwnerAssignable(actorAdminId, ownerAdminId)
    : toObjectIdStrict(actorAdminId, "actorAdminId");

  const { adminId: execObj, admin, from, executiveName } = await getAdminSender(targetOwnerId);
  const recipients = normalizeEmails(to);
  const ccList = normalizeEmails(cc);
  const bccList = normalizeEmails(bcc);

  if (!recipients.length) throw new Error("At least one recipient is required");

  const finalSubject = cleanStr(subject) || "Collab Opportunity";
  const results = [];

  for (const recipientEmail of recipients) {
    const thread = await createOrGetThread({
      executiveId: execObj,
      role: admin.role,
      senderEmail: from,
      recipientEmail,
      subject: finalSubject,
      actorAdminId,
    });

    let finalText = text;
    let finalHtml = html;
    let finalEmailSubject = finalSubject;

    if (!finalText && !finalHtml) {
      const templ = collabOpportunityBulkTemplate({
        influencerName: recipientEmail.split("@")[0],
        campaignTitle: "our campaign",
        replyToEmail: thread.replyToEmail,
        executiveName,
      });

      finalText = templ.text;
      finalHtml = templ.html;
      finalEmailSubject = templ.subject || finalSubject;
    }

    const sent = await saveOutboundAndSend({
      thread,
      to: recipientEmail,
      from,
      cc: ccList,
      bcc: bccList,
      subject: finalEmailSubject,
      text: finalText,
      html: finalHtml,
      executiveId: execObj,
      actorAdminId,
      meta: {
        source: "MANUAL_COMPOSE",
        role: admin.role,
      },
    });

    results.push({
      email: recipientEmail,
      success: true,
      ...sent,
    });
  }

  return {
    total: results.length,
    sent: results.length,
    failed: 0,
    results,
  };
}

async function sendBulkEmailToCsv({
  adminId,
  csvBuffer,
  subject,
  text,
  html,
  campaignId = null,
  pipelineIdByEmail = {},
  ownerAdminId = null,
}) {
  if (!csvBuffer?.length) throw new Error("CSV file is required");

  const targetOwnerId = ownerAdminId
    ? await assertOwnerAssignable(adminId, ownerAdminId)
    : toObjectIdStrict(adminId, "adminId");

  const sts = new STSClient({ region });
  const whoAmI = await sts.send(new GetCallerIdentityCommand({}));
  console.log("AWS CALLER:", whoAmI);

  const { adminId: execObj, admin, from, executiveName } = await getAdminSender(targetOwnerId);
  const recipients = parseRecipientsFromCsv(csvBuffer);
  if (!recipients.length) throw new Error("No valid recipients found in CSV");

  const finalSubject = cleanStr(subject) || "Collab Opportunity";
  const results = [];

  for (const recipient of recipients) {
    try {
      const to = cleanEmail(recipient.email);
      const recipientName = cleanStr(recipient.name) || "there";
      const matchedPipelineId = pipelineIdByEmail[to] || null;

      const thread = await createOrGetThread({
        pipelineId: matchedPipelineId,
        campaignId,
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        subject: finalSubject,
        actorAdminId: adminId,
      });

      let finalText = text;
      let finalHtml = html;
      let finalEmailSubject = finalSubject;

      if (!finalText && !finalHtml) {
        const templ = collabOpportunityBulkTemplate({
          influencerName: recipientName,
          campaignTitle: "our campaign",
          replyToEmail: thread.replyToEmail,
          executiveName,
        });

        finalText = templ.text;
        finalHtml = templ.html;
        finalEmailSubject = templ.subject || finalSubject;
      }

      const sent = await saveOutboundAndSend({
        thread,
        to,
        from,
        subject: finalEmailSubject,
        text: finalText,
        html: finalHtml,
        executiveId: execObj,
        actorAdminId: adminId,
        meta: {
          source: "CSV",
          recipientName,
          role: admin.role,
        },
      });

      results.push({ email: to, name: recipientName, success: true, ...sent });
    } catch (error) {
      results.push({
        email: recipient.email,
        name: recipient.name,
        success: false,
        error: error?.message || "Failed",
      });
    }
  }

  return {
    executiveId: String(execObj),
    from,
    role: admin.role,
    total: results.length,
    sent: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

async function getPipelineRecipientsForComposeService({ actor, actorAdminId, campaignId, pipelineIds }) {
  await getActorAdmin(actorAdminId);

  if (!campaignId) throw new Error("campaignId is required");

  const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
  if (!allowedCampaign) throw new Error("You are not allowed to access this campaign");

  const validIds = Array.isArray(pipelineIds)
    ? pipelineIds.map((id) => cleanStr(id)).filter((id) => mongoose.Types.ObjectId.isValid(id))
    : [];

  if (!validIds.length) throw new Error("pipelineIds are required");

  const rows = await InfluencerPipeline.find({
    _id: { $in: validIds },
    campaignId,
  }).lean();

  const pipelineObjectIds = rows.map((row) => row._id);
  const threads = await AdminEmailThreadModel.find({
    pipelineId: { $in: pipelineObjectIds },
  })
    .select("pipelineId replyToEmail _id")
    .lean();

  const threadByPipelineId = new Map(
    threads.map((item) => [String(item.pipelineId), item])
  );

  return rows
    .filter((row) => cleanEmail(row.email))
    .map((row) => {
      const thread = threadByPipelineId.get(String(row._id));
      return {
        pipelineId: String(row._id),
        campaignId: String(row.campaignId || ""),
        name: cleanStr(row.name) || cleanStr(row.email),
        email: cleanEmail(row.email),
        company: "",
        niche: Array.isArray(row.niche) ? row.niche : [],
        status: row.status || "outreach",
        threadId: thread?._id ? String(thread._id) : null,
        replyToEmail: thread?.replyToEmail || null,
      };
    });
}

async function sendSelectedPipelineEmailsService({
  actor,
  actorAdminId,
  campaignId,
  pipelineIds,
  subject,
  text,
  html,
  ownerAdminId = null,
}) {
  await getActorAdmin(actorAdminId);

  const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
  if (!allowedCampaign) throw new Error("You are not allowed to access this campaign");

  const targetOwnerId = ownerAdminId
    ? await assertOwnerAssignable(actorAdminId, ownerAdminId)
    : toObjectIdStrict(actorAdminId, "actorAdminId");

  const { adminId: execObj, admin, from, executiveName } = await getAdminSender(targetOwnerId);

  const validIds = Array.isArray(pipelineIds)
    ? pipelineIds.map((id) => cleanStr(id)).filter((id) => mongoose.Types.ObjectId.isValid(id))
    : [];

  if (!validIds.length) throw new Error("pipelineIds are required");

  const rows = await InfluencerPipeline.find({
    _id: { $in: validIds },
    campaignId,
  }).lean();

  if (!rows.length) throw new Error("No valid pipeline rows found");

  const finalSubject = cleanStr(subject) || "Collab Opportunity";
  const results = [];

  for (const row of rows) {
    try {
      const to = cleanEmail(row.email);
      if (!to || !isValidEmail(to)) {
        results.push({
          pipelineId: String(row._id),
          email: row.email || "",
          name: row.name || "",
          success: false,
          error: "Valid email missing",
        });
        continue;
      }

      const recipientName = cleanStr(row.name) || "there";

      const thread = await createOrGetThread({
        pipelineId: row._id,
        campaignId: row.campaignId,
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        subject: finalSubject,
        actorAdminId,
      });

      let finalText = text;
      let finalHtml = html;
      let finalEmailSubject = finalSubject;

      if (!finalText && !finalHtml) {
        const templ = collabOpportunityBulkTemplate({
          influencerName: recipientName,
          campaignTitle: "our campaign",
          replyToEmail: thread.replyToEmail,
          executiveName,
        });

        finalText = templ.text;
        finalHtml = templ.html;
        finalEmailSubject = templ.subject || finalSubject;
      }

      const sent = await saveOutboundAndSend({
        thread,
        to,
        from,
        subject: finalEmailSubject,
        text: finalText,
        html: finalHtml,
        executiveId: execObj,
        actorAdminId,
        meta: {
          source: "PIPELINE_SELECTION",
          recipientName,
          role: admin.role,
          pipelineId: String(row._id),
          campaignId: String(row.campaignId || ""),
        },
      });

      await InfluencerPipeline.updateOne(
        { _id: row._id },
        {
          $set: {
            updatedByAdmin: execObj,
            outreached: true,
            outreachDate: new Date(),
          },
        }
      );

      results.push({
        pipelineId: String(row._id),
        email: to,
        name: recipientName,
        success: true,
        ...sent,
      });
    } catch (error) {
      results.push({
        pipelineId: String(row._id),
        email: row.email || "",
        name: row.name || "",
        success: false,
        error: error?.message || "Failed",
      });
    }
  }

  return {
    total: results.length,
    sent: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

async function getThreadConversationState({
  pipelineId = null,
  recipientEmail = null,
  actorAdminId,
}) {
  const email = cleanEmail(recipientEmail);

  const emptyState = {
    threadId: null,
    outreachSentAt: null,
    followUp1SentAt: null,
    followUp2SentAt: null,
    replyChecked: false,
    repliedAt: null,
    replyText: "",
  };

  const scope = await getActorScope(actorAdminId);

  let thread = null;

  if (pipelineId) {
    const pipelineObj = toObjectIdStrict(pipelineId, "pipelineId");

    const filter = { pipelineId: pipelineObj };
    if (scope.adminIds !== null) {
      filter.executiveId = { $in: scope.adminIds };
    }

    thread = await AdminEmailThreadModel.findOne(filter)
      .sort({ lastMessageAt: -1 })
      .lean();
  }

  // fallback by recipient email if no pipeline-linked thread found
  if (!thread && email) {
    const filter = { recipientEmail: email };
    if (scope.adminIds !== null) {
      filter.executiveId = { $in: scope.adminIds };
    }

    thread = await AdminEmailThreadModel.findOne(filter)
      .sort({ lastMessageAt: -1 })
      .lean();
  }

  if (!thread) return emptyState;

  const messages = await AdminEmailMessageModel.find({ threadId: thread._id })
    .sort({ createdAt: 1 })
    .lean();

  const outbound = messages.filter((m) => m.direction === "OUTBOUND");
  const inbound = messages.filter((m) => m.direction === "INBOUND");
  const firstInbound = inbound[0] || null;

  return {
    threadId: String(thread._id),
    outreachSentAt: outbound[0]?.createdAt || null,
    followUp1SentAt: outbound[1]?.createdAt || null,
    followUp2SentAt: outbound[2]?.createdAt || null,
    replyChecked: !!firstInbound,
    repliedAt: firstInbound?.createdAt || null,
    replyText: cleanStr(firstInbound?.textPreview || firstInbound?.htmlPreview),
  };
}

module.exports = {
  getMailboxScopeService,
  sendBulkEmailToCsv,
  listThreads,
  getThreadMessages,
  replyToThread,
  updateThreadService,
  composeManualEmailService,
  getPipelineRecipientsForComposeService,
  sendSelectedPipelineEmailsService,
  getThreadConversationState,
  getBrandOutreachRecipientsForComposeService,
  sendSelectedBrandOutreachEmailsService,
  getBrandThreadConversationState,
};