// services/emailLinking.js

const { EmailThread, EmailMessage } = require('../models/email');

function norm(e) {
  return String(e || '').trim().toLowerCase();
}

async function linkConversationsForInfluencer(influencer, externalEmail) {
  const normalized = norm(externalEmail || influencer.email);
  if (!normalized) return;

  // 1) Threads where snapshot email matches
  const threadIdsFromSnapshot = await EmailThread.find(
    { 'influencerSnapshot.email': normalized },
    '_id'
  ).lean();
  const threadIds1 = threadIdsFromSnapshot.map(t => t._id);

  // 2) Threads that have messages with this real email
  const threadIdsFromMessages = await EmailMessage.distinct('thread', {
    $or: [{ toRealEmail: normalized }, { fromRealEmail: normalized }],
  });

  const allThreadIds = Array.from(new Set([...threadIds1, ...threadIdsFromMessages]));
  if (!allThreadIds.length) return;

  // 3) Attach threads
  await EmailThread.updateMany(
    { _id: { $in: allThreadIds } },
    {
      $set: {
        influencer: influencer._id,
        'influencerSnapshot.name': influencer.name,
        'influencerSnapshot.email': influencer.email,
      },
    }
  );
}

module.exports = { linkConversationsForInfluencer };
