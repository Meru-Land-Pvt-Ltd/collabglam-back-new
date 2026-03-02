// controllers/mediakitController.js
const Influencer = require('../models/influencer');
const MediaKit = require('../models/mediaKit');
const { refreshMediaKitForInfluencer } = require('../jobs/mediakitSync');
const Modash = require('../models/modash'); 

// ------------------------------- Helpers --------------------------------

// Helper to pick username based on primary platform and profiles
function pickUsername(primaryPlatform, profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  if (primaryPlatform) {
    const match = profiles.find(p => p.provider === primaryPlatform);
    if (match?.username) return match.username;
  }
  return profiles.find(p => p?.username)?.username ?? null;
}

// Helper to sanitize MediaKit objects (remove sensitive fields)
function sanitizeMediaKit(docOrObj) {
  const obj = docOrObj?.toObject ? docOrObj.toObject() : { ...docOrObj };
  // redact sensitive snapshot fields from responses
  delete obj.password;
  return obj;
}

// Helper to build snapshot from Influencer document
function buildSnapshotFromInfluencer(infDoc) {
  const src = infDoc.toObject({ getters: false, virtuals: false, depopulate: true });

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

// Map Modash docs → MediaKit.socialProfiles format (public-safe)
function mapModashToSocialProfiles(modashDocs = []) {
  if (!Array.isArray(modashDocs)) return [];

  return modashDocs.map((p) => ({
    provider: p.provider,                         // 'instagram' | 'tiktok' | 'youtube'
    username: p.username || p.handle || null,
    fullname: p.fullname || null,
    url: p.url || null,
    picture: p.picture || null,

    followers: p.followers ?? null,
    engagements: p.engagements ?? null,
    engagementRate: p.engagementRate ?? null,
    averageViews: p.averageViews ?? null,

    // keep compact stats + categories
    stats: p.stats || null,
    categories: Array.isArray(p.categories) ? p.categories : [],

    // light-weight content & affinity
    recentPosts: Array.isArray(p.recentPosts) ? p.recentPosts : [],
    popularPosts: Array.isArray(p.popularPosts) ? p.popularPosts : [],
    hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
    mentions: Array.isArray(p.mentions) ? p.mentions : [],
    brandAffinity: Array.isArray(p.brandAffinity) ? p.brandAffinity : [],
    lookalikes: Array.isArray(p.lookalikes) ? p.lookalikes : [],
    sponsoredPosts: Array.isArray(p.sponsoredPosts) ? p.sponsoredPosts : [],

    // timestamps from Modash doc
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null
  }));
}

// ------------------------------- Controllers ----------------------------

async function createByInfluencer(req, res) {
  try {
    const { influencerId } = req.body || {};
    if (!influencerId) {
      return res.status(400).json({ error: 'influencerId is required in body' });
    }

    const influencer = await Influencer.findOne({ influencerId });
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    // 1) Fetch Modash profiles and map → socialProfiles snapshot
    const modashProfiles = await Modash.find({ influencer: influencer._id }).lean();
    const socialProfilesSnapshot = mapModashToSocialProfiles(modashProfiles);

    // 2) If MediaKit exists, refresh + patch socialProfiles
    const existing = await MediaKit.findOne({ influencerId });
    if (existing) {
      const refreshed = await refreshMediaKitForInfluencer(influencerId);
      const doc = refreshed || existing;

      if (socialProfilesSnapshot.length) {
        doc.socialProfiles = socialProfilesSnapshot;
        await doc.save();
      }

      return res.status(200).json({
        mediaKitId: doc.mediaKitId,
        mediaKit: sanitizeMediaKit(doc),
      });
    }

    // 3) Otherwise create new MediaKit from Influencer snapshot
    const snapshot = buildSnapshotFromInfluencer(influencer);
    const mediaKit = await MediaKit.create({
      influencerId,
      ...snapshot,
      socialProfiles: socialProfilesSnapshot,
    });

    return res.status(201).json({
      mediaKitId: mediaKit.mediaKitId,
      mediaKit: sanitizeMediaKit(mediaKit),
    });
  } catch (err) {
    console.error('Create MediaKit error:', err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Duplicate key', details: err.keyValue });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/mediakits/update
// Body: { mediaKitId, ...fieldsToUpdate }
// Fully flexible update of MediaKit
async function updateMediaKit(req, res) {
  try {
    const { mediaKitId, ...rest } = req.body || {};
    if (!mediaKitId) {
      return res.status(400).json({ error: 'mediaKitId is required in body' });
    }

    const updated = await MediaKit.findOneAndUpdate(
      { mediaKitId },
      { $set: rest },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ error: 'MediaKit not found' });

    return res.json({
      message: 'MediaKit updated successfully',
      mediaKitId: updated.mediaKitId,
      mediaKit: sanitizeMediaKit(updated)
    });
  } catch (err) {
    console.error('Update MediaKit error:', err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Duplicate key', details: err.keyValue });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Returns array of sanitized MediaKits with trimmed socialProfiles
async function getAllMediaKits(_req, res) {
  try {
    const docs = await MediaKit.find(
      {},
      {
        _id: 0,
        __v: 0,
        password: 0
      }
    ).lean();

    // If some kits don't have socialProfiles yet, we can fill them from Modash
    const items = await Promise.all(
      (docs || []).map(async (d) => {
        const kit = { ...d };

        if (!Array.isArray(kit.socialProfiles) || kit.socialProfiles.length === 0) {
          if (kit.influencerId) {
            const modashProfiles = await Modash.find({ influencerId: kit.influencerId }).lean();
            kit.socialProfiles = mapModashToSocialProfiles(modashProfiles);
          } else {
            kit.socialProfiles = [];
          }
        } else {
          // in case old docs store full Modash docs, remap them to the slim form
          kit.socialProfiles = mapModashToSocialProfiles(kit.socialProfiles);
        }

        return kit;
      })
    );

    return res.json(items);
  } catch (err) {
    console.error('Get all MediaKits error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}


// POST /api/mediakits/sync/by-influencer
// Body: { influencerId }
// Manually refreshes an existing MediaKit from the latest Influencer data
async function syncByInfluencer(req, res) {
  try {
    const { influencerId } = req.body || {};
    if (!influencerId) {
      return res.status(400).json({ error: 'influencerId is required in body' });
    }

    const updated = await refreshMediaKitForInfluencer(influencerId);
    if (!updated) {
      return res.status(404).json({ error: 'MediaKit not found for this influencerId' });
    }

    return res.json({
      message: 'MediaKit synced from Influencer successfully',
      mediaKitId: updated.mediaKitId,
      mediaKit: sanitizeMediaKit(updated)
    });
  } catch (err) {
    console.error('Sync MediaKit error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createByInfluencer,
  updateMediaKit,
  getAllMediaKits,
  syncByInfluencer
};
