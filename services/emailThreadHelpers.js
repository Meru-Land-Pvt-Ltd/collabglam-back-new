function cleanStr(v) {
  return String(v ?? "").trim();
}

function cleanEmail(v) {
  return cleanStr(v).toLowerCase();
}

function buildThreadReplyAddress(threadId) {
  const domain = process.env.INBOUND_REPLY_DOMAIN || "mail.collabglam.cloud";
  return `reply+t_${threadId}@${domain}`.toLowerCase();
}

function extractThreadIdFromReplyAddress(email) {
  const clean = cleanEmail(email);
  const match = clean.match(/^reply\+t_([a-f0-9]{24})@/i);
  return match ? match[1] : null;
}

function buildReferences(previousMessage) {
  const refs = Array.isArray(previousMessage?.references)
    ? previousMessage.references.filter(Boolean)
    : [];

  if (previousMessage?.messageId && !refs.includes(previousMessage.messageId)) {
    refs.push(previousMessage.messageId);
  }

  return refs;
}

module.exports = {
  cleanStr,
  cleanEmail,
  buildThreadReplyAddress,
  extractThreadIdFromReplyAddress,
  buildReferences,
};