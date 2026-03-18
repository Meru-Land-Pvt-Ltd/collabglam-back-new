const mongoose = require("mongoose");
const AdminEmailThreadModel = require("../models/adminEmailThread");
const AdminEmailMessageModel = require("../models/adminEmailMessage");
const {
  extractThreadIdFromReplyAddress,
  cleanEmail,
} = require("../utils/emailThread.util");

async function saveInboundEmail({
  recipients = [],
  from,
  subject,
  text,
  html,
  messageId,
  inReplyTo,
  references = [],
  rawHeaders,
  s3Bucket,
  s3Key,
}) {
  const replyAddress = recipients.find((r) => /^reply\+t_/i.test(r));
  if (!replyAddress) throw new Error("Reply address not found");

  const threadId = extractThreadIdFromReplyAddress(replyAddress);
  if (!threadId || !mongoose.isValidObjectId(threadId)) {
    throw new Error("Invalid thread id in reply address");
  }

  const thread = await AdminEmailThreadModel.findById(threadId);
  if (!thread) throw new Error("Thread not found");

  const msg = await AdminEmailMessageModel.create({
    threadId: thread._id,
    direction: "INBOUND",
    subject: subject || thread.subject || "(no subject)",
    from: cleanEmail(from),
    to: recipients.map(cleanEmail),
    messageId: messageId || null,
    inReplyTo: inReplyTo || null,
    references,
    provider: "SES",
    providerStatus: "RECEIVED",
    textPreview: text ? String(text).slice(0, 5000) : null,
    htmlPreview: html ? String(html).slice(0, 10000) : null,
    s3Bucket: s3Bucket || null,
    s3Key: s3Key || null,
    rawHeaders: rawHeaders || null,
  });

  thread.lastMessageAt = new Date();
  thread.lastMessageDirection = "INBOUND";
  await thread.save();

  return {
    threadId: String(thread._id),
    emailMessageId: String(msg._id),
  };
}

module.exports = {
  saveInboundEmail,
};