// services/mediakitSync.js
const Influencer = require('../models/influencer');
const MediaKit = require('../models/mediaKit');

/** Build a MediaKit snapshot from an Influencer doc/object (mirrors controller logic) */
function buildSnapshotFromInfluencer(anyDoc) {
  const docToObj = d =>
    d?.toObject
      ? d.toObject({ getters: false, virtuals: false, depopulate: true })
      : { ...d };

  const src = docToObj(anyDoc);

  const EXCLUDE = new Set(['_id', '__v', 'mediaKitId', 'influencerId', 'updatedAt']);
  const MEDIAKIT_ONLY = new Set(['rateCard', 'additionalNotes', 'mediaKitPdf', 'website']);

  const snapshot = {};
  for (const path of Object.keys(MediaKit.schema.paths)) {
    if (EXCLUDE.has(path) || MEDIAKIT_ONLY.has(path)) continue;

    if (path === 'createdAt') {
      if (src.createdAt) snapshot.createdAt = src.createdAt;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(src, path)) {
      snapshot[path] = src[path];
    }
  }
  return snapshot;
}

/**
 * Refresh an existing MediaKit from the latest Influencer data.
 * NOTE: Only snapshot fields are updated; MediaKit-only fields (rateCard, additionalNotes, mediaKitPdf, website) are preserved.
 */
async function refreshMediaKitForInfluencer(influencerId) {
  const influencer = await Influencer.findOne({ influencerId });
  if (!influencer) return null;

  const snapshot = buildSnapshotFromInfluencer(influencer);

  // Update ONLY if a MediaKit already exists (no surprise upserts here)
  const updated = await MediaKit.findOneAndUpdate(
    { influencerId },
    { $set: snapshot },
    { new: true, runValidators: true }
  );

  return updated; // can be null if there's no MediaKit yet
}

module.exports = {
  refreshMediaKitForInfluencer
};
