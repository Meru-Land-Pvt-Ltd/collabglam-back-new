const mongoose = require("mongoose");

const cleanStr = (value) => String(value ?? "").trim();
const cleanEmail = (value) => cleanStr(value).toLowerCase();

function toObjectIdStrict(id, fieldName) {
  const clean = cleanStr(id);
  if (!mongoose.isValidObjectId(clean)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return new mongoose.Types.ObjectId(clean);
}

function buildThreadReplyAddress(threadId) {
  const domain = process.env.INBOUND_REPLY_DOMAIN || "reply.mail.collabglam.cloud";
  return `t_${threadId}@${domain}`.toLowerCase();
}

function extractThreadIdFromReplyAddress(email) {
  const clean = cleanEmail(email);
  const match = clean.match(/^reply\+t_([a-f0-9]{24})@/i);
  return match ? match[1] : null;
}

function buildReferences(lastMessage) {
  const refs = Array.isArray(lastMessage?.references)
    ? lastMessage.references.filter(Boolean)
    : [];

  if (lastMessage?.messageId && !refs.includes(lastMessage.messageId)) {
    refs.push(lastMessage.messageId);
  }

  return refs;
}

module.exports = {
  cleanStr,
  cleanEmail,
  toObjectIdStrict,
  buildThreadReplyAddress,
  extractThreadIdFromReplyAddress,
  buildReferences,
};