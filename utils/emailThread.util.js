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
  const domain = process.env.INBOUND_REPLY_DOMAIN || "team.collabglam.com";
  return `t_${threadId}@${domain}`.toLowerCase();
}

function extractThreadIdFromReplyAddress(email) {
  const clean = cleanEmail(email);
  const escapedDomain = (process.env.INBOUND_REPLY_DOMAIN || "team.collabglam.com")
    .replace(/\./g, "\\.");

  const regex = new RegExp(`^t_([a-f0-9]{24})@${escapedDomain}$`, "i");
  const match = clean.match(regex);

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