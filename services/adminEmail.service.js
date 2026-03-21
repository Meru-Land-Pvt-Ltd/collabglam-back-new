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

function mapAdminRoleToThreadRole(role) {
  const allowedRoles = [
    ROLES.SUPER_ADMIN,
    ROLES.REVENUE_HEAD,
    ROLES.IME,
    ROLES.BME,
  ];

  if (!allowedRoles.includes(role)) {
    throw new Error("Unsupported admin role");
  }

  return role;
}

async function getActorAdmin(actorAdminId) {
  const actorObj = toObjectIdStrict(actorAdminId, "actorAdminId");

  const actor = await AdminModel.findById(actorObj)
    .select("_id name email proxyEmail role status parentAdmin rootAdmin")
    .lean();

  if (!actor) {
    throw new Error("Admin not found");
  }

  const allowedRoles = [
    ROLES.SUPER_ADMIN,
    ROLES.REVENUE_HEAD,
    ROLES.IME,
    ROLES.BME,
  ];

  if (!actor.role || !allowedRoles.includes(actor.role)) {
    throw new Error("Unsupported admin role");
  }

  if (String(actor.status || "").toLowerCase() !== "active") {
    throw new Error("Admin account is not active");
  }

  return actor;
}

async function getAccessibleAdminIds(actorAdminId) {
  const actor = await getActorAdmin(actorAdminId);

  if (actor.role === ROLES.SUPER_ADMIN) {
    return null;
  }

  if (actor.role === ROLES.REVENUE_HEAD) {
    const childAdmins = await AdminModel.find({
      parentAdmin: actor._id,
      role: { $in: [ROLES.IME, ROLES.BME] },
    })
      .select("_id")
      .lean();

    return [actor._id, ...childAdmins.map((item) => item._id)];
  }

  if ([ROLES.IME, ROLES.BME].includes(actor.role)) {
    return [actor._id];
  }

  throw new Error("Unsupported admin role");
}

async function assertThreadAccess(thread, actorAdminId) {
  const accessibleAdminIds = await getAccessibleAdminIds(actorAdminId);

  if (accessibleAdminIds === null) {
    return true;
  }

  const allowed = accessibleAdminIds.some(
    (id) => String(id) === String(thread.executiveId)
  );

  if (!allowed) {
    throw new Error("You are not allowed to access this thread");
  }

  return true;
}

async function getAdminSender(adminId) {
  const execObj = toObjectIdStrict(adminId, "adminId");

  const admin = await AdminModel.findById(execObj)
    .select("name email proxyEmail proxyemail role status")
    .lean();

  if (!admin) throw new Error("Admin not found");

  const allowedRoles = [
    ROLES.SUPER_ADMIN,
    ROLES.REVENUE_HEAD,
    ROLES.IME,
    ROLES.BME,
  ];

  if (!admin.role || !allowedRoles.includes(admin.role)) {
    throw new Error(
      "Only super_admin, revenue_head, ime, or bme can send bulk emails"
    );
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
  executiveId,
  role,
  senderEmail,
  recipientEmail,
  subject,
}) {
  let thread = await AdminEmailThreadModel.findOne({
    executiveId,
    recipientEmail,
  });

  if (!thread) {
    thread = await AdminEmailThreadModel.create({
      executiveId,
      role: mapAdminRoleToThreadRole(role),
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
    thread.role = mapAdminRoleToThreadRole(role);

    if (!thread.replyToEmail) {
      thread.replyToEmail = buildThreadReplyAddress(thread._id);
    }

    await thread.save();
  }

  return thread;
}

async function saveOutboundAndSend({
  thread,
  to,
  from,
  subject,
  text,
  html,
  executiveId,
  meta = {},
}) {
  const lastMessage = await AdminEmailMessageModel.findOne({
    threadId: thread._id,
  })
    .sort({ createdAt: -1 })
    .lean();

  const references = lastMessage ? buildReferences(lastMessage) : [];

  const emailMessage = await AdminEmailMessageModel.create({
    threadId: thread._id,
    direction: "OUTBOUND",
    subject,
    from,
    to: [to],
    replyTo: [thread.replyToEmail],
    inReplyTo: lastMessage?.messageId || null,
    references,
    provider: "SES",
    providerStatus: "QUEUED",
    textPreview: text ? text.slice(0, 1000) : null,
    htmlPreview: html ? String(html).slice(0, 2000) : null,
  });

  const { messageId } = await sendEmail({
    to,
    subject,
    text,
    html,
    from,
    replyTo: [thread.replyToEmail],
    configurationSetName: process.env.SES_CONFIGURATION_SET,
    emailTags: [
      { Name: "threadId", Value: String(thread._id) },
      { Name: "executiveId", Value: String(executiveId) },
      { Name: "source", Value: meta.source || "CSV" },
    ],
  });

  let s3Key = null;

  try {
    s3Key = await uploadEmailRecordToS3({
      type: "OUTBOUND_EMAIL",
      provider: "SES",
      threadId: String(thread._id),
      emailMessageId: String(emailMessage._id),
      executiveId: String(executiveId),
      to,
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

  return {
    threadId: String(thread._id),
    emailMessageId: String(emailMessage._id),
    sesMessageId: messageId || null,
    replyToEmail: thread.replyToEmail,
    s3Key,
  };
}

async function sendBulkEmailToCsv({ adminId, csvBuffer, subject, text, html }) {
  if (!csvBuffer?.length) {
    throw new Error("CSV file is required");
  }

  const sts = new STSClient({ region });
  const whoAmI = await sts.send(new GetCallerIdentityCommand({}));
  console.log("AWS CALLER:", whoAmI);

  const {
    adminId: execObj,
    admin,
    from,
    executiveName,
  } = await getAdminSender(adminId);

  const recipients = parseRecipientsFromCsv(csvBuffer);

  if (!recipients.length) {
    throw new Error("No valid recipients found in CSV");
  }

  const finalSubject = cleanStr(subject) || "Collab Opportunity";
  const results = [];

  for (const recipient of recipients) {
    try {
      const to = cleanEmail(recipient.email);
      const recipientName = cleanStr(recipient.name) || "there";

      const thread = await createOrGetThread({
        executiveId: execObj,
        role: admin.role,
        senderEmail: from,
        recipientEmail: to,
        subject: finalSubject,
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
        meta: {
          source: "CSV",
          recipientName,
          role: admin.role,
        },
      });

      results.push({
        email: to,
        name: recipientName,
        success: true,
        ...sent,
      });
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

async function listThreads({ actorAdminId, page = 1, limit = 20 }) {
  const accessibleAdminIds = await getAccessibleAdminIds(actorAdminId);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const filter =
    accessibleAdminIds === null
      ? {}
      : { executiveId: { $in: accessibleAdminIds } };

  const [items, total] = await Promise.all([
    AdminEmailThreadModel.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate("executiveId", "name email proxyEmail role parentAdmin rootAdmin")
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

  const thread = await AdminEmailThreadModel.findById(tid)
    .populate("executiveId", "name email proxyEmail role parentAdmin rootAdmin")
    .lean();

  if (!thread) throw new Error("Thread not found");

  await assertThreadAccess(thread, actorAdminId);

  const messages = await AdminEmailMessageModel.find({ threadId: tid })
    .sort({ createdAt: 1 })
    .lean();

  return { thread, messages };
}

async function replyToThread({ threadId, actorAdminId, subject, text, html }) {
  const tid = toObjectIdStrict(threadId, "threadId");

  const thread = await AdminEmailThreadModel.findById(tid).lean();
  if (!thread) throw new Error("Thread not found");

  await assertThreadAccess(thread, actorAdminId);

  const finalSubject = cleanStr(subject) || thread.subject;
  const to = thread.recipientEmail;

  return saveOutboundAndSend({
    thread,
    to,
    from: thread.senderEmail,
    subject: finalSubject,
    text,
    html,
    executiveId: thread.executiveId,
    meta: {
      source: "THREAD_REPLY",
      repliedByAdminId: String(actorAdminId),
    },
  });
}

module.exports = {
  sendBulkEmailToCsv,
  listThreads,
  getThreadMessages,
  replyToThread,
};