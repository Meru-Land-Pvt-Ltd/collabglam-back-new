const { InfluencerModel: Influencer } = require("../models/influencer");
const mongoose = require("mongoose");
const MediaKit = require("../models/mediaKit");
const { refreshMediaKitForInfluencer } = require("../jobs/mediakitSync");
const Modash = require("../models/modash");
const Language = require("../models/language");

// ------------------------------- Helpers --------------------------------

function pickUsername(primaryPlatform, profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;

  if (primaryPlatform) {
    const match = profiles.find((p) => p.provider === primaryPlatform);
    if (match?.username) return match.username;
  }

  return profiles.find((p) => p?.username)?.username ?? null;
}

function sanitizeMediaKit(docOrObj) {
  const obj = docOrObj?.toObject ? docOrObj.toObject() : { ...docOrObj };
  delete obj.password;
  delete obj.passwordHash;
  return obj;
}

function buildSnapshotFromInfluencer(infDoc) {
  const src = infDoc?.toObject
    ? infDoc.toObject({ getters: false, virtuals: false, depopulate: true })
    : { ...infDoc };

  const EXCLUDE = new Set([
    "_id",
    "__v",
    "mediaKitId",
    "influencerId",
    "updatedAt",
    "password",
  ]);

  const MEDIAKIT_ONLY = new Set([
    "rateCard",
    "additionalNotes",
    "mediaKitPdf",
    "website",
  ]);

  const snapshot = {};

  for (const path of Object.keys(MediaKit.schema.paths)) {
    if (EXCLUDE.has(path) || MEDIAKIT_ONLY.has(path)) continue;

    if (path === "createdAt") {
      if (src.createdAt) snapshot.createdAt = src.createdAt;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(src, path)) {
      snapshot[path] = src[path];
    }
  }

  return snapshot;
}

function normalizeSnapshotForMediaKit(snapshot = {}, influencer = null) {
  const normalized = { ...snapshot };

  if (!normalized.country && influencer?.countryName) {
    normalized.country = influencer.countryName;
  }

  delete normalized.countryName;
  return normalized;
}

async function normalizeLanguagesForMediaKit(influencerLanguages = []) {
  if (!Array.isArray(influencerLanguages) || influencerLanguages.length === 0) {
    return [];
  }

  const ids = influencerLanguages
    .map((l) => l?.languageId || l?._id)
    .filter(Boolean);

  if (ids.length === 0) return [];

  const languageDocs = await Language.find({ _id: { $in: ids } })
    .select("_id code name")
    .lean();

  const byId = new Map(languageDocs.map((l) => [String(l._id), l]));

  return influencerLanguages
    .map((l) => {
      const id = l?.languageId || l?._id;
      if (!id) return null;

      const full = byId.get(String(id));
      if (!full) return null;

      return {
        languageId: full._id,
        code: full.code,
        name: full.name,
      };
    })
    .filter(Boolean);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanModashDoc(docOrObj) {
  const obj = docOrObj?.toObject
    ? docOrObj.toObject({ getters: false, virtuals: false, depopulate: true })
    : { ...docOrObj };

  delete obj.__v;
  return obj;
}

function mapModashToSocialProfiles(modashDocs = [], opts = {}) {
  if (!Array.isArray(modashDocs)) return [];

  const viewerRole = String(opts.viewerRole || '').toLowerCase();
  const hideContacts = opts.hideContacts === true || viewerRole === 'brand';

  function sanitizeProviderRaw(providerRaw) {
    if (!providerRaw || typeof providerRaw !== 'object') return providerRaw;

    const out = JSON.parse(JSON.stringify(providerRaw));

    if (hideContacts) {
      delete out.contacts;
      if (out.profile && typeof out.profile === 'object') {
        delete out.profile.contacts;
      }
    }

    return out;
  }

  return modashDocs.map((doc) => {
    const raw = cleanModashDoc(doc);
    const safeProviderRaw = sanitizeProviderRaw(raw.providerRaw);

    return {
      modashId: raw._id ? String(raw._id) : null,

      // keep everything from saved Modash report
      ...raw,

      // normalize important fields for frontend
      provider: raw.provider || null,
      userId: raw.userId || null,
      username: raw.username || raw.handle || null,
      handle: raw.handle || (raw.username ? `@${raw.username}` : null),
      fullname: raw.fullname || null,
      url: raw.url || null,
      picture: raw.picture || null,

      followers: raw.followers ?? null,
      engagements: raw.engagements ?? null,
      engagementRate: raw.engagementRate ?? null,
      averageViews: raw.averageViews ?? null,

      isPrivate: raw.isPrivate ?? null,
      isVerified: raw.isVerified ?? null,
      accountType: raw.accountType ?? null,
      secUid: raw.secUid ?? null,

      city: raw.city || null,
      state: raw.state || null,
      subdivision: raw.subdivision || null,
      country: raw.country || null,
      ageGroup: raw.ageGroup || null,
      gender: raw.gender || null,
      language: raw.language || null,
      bio: raw.bio || null,

      stats: raw.stats || null,
      statsByContentType: raw.statsByContentType || null,

      postsCount: raw.postsCount ?? null,
      postsCounts: raw.postsCounts ?? null,
      avgLikes: raw.avgLikes ?? null,
      avgComments: raw.avgComments ?? null,
      avgViews: raw.avgViews ?? null,
      avgReelsPlays: raw.avgReelsPlays ?? null,
      totalLikes: raw.totalLikes ?? null,
      totalViews: raw.totalViews ?? null,

      categories: normalizeArray(raw.categories),
      hashtags: normalizeArray(raw.hashtags),
      mentions: normalizeArray(raw.mentions),
      brandAffinity: normalizeArray(raw.brandAffinity),
      interests: normalizeArray(raw.interests),
      contacts: hideContacts ? [] : normalizeArray(raw.contacts),

      audience: raw.audience || null,
      audienceCommenters: raw.audienceCommenters || null,
      audienceExtra: raw.audienceExtra || null,
      lookalikes: normalizeArray(raw.lookalikes),

      recentPosts: normalizeArray(raw.recentPosts),
      popularPosts: normalizeArray(raw.popularPosts),
      sponsoredPosts: normalizeArray(raw.sponsoredPosts),
      statHistory: normalizeArray(raw.statHistory),

      paidPostPerformance: raw.paidPostPerformance ?? null,
      paidPostPerformanceViews: raw.paidPostPerformanceViews ?? null,
      sponsoredPostsMedianViews: raw.sponsoredPostsMedianViews ?? null,
      sponsoredPostsMedianLikes: raw.sponsoredPostsMedianLikes ?? null,
      nonSponsoredPostsMedianViews: raw.nonSponsoredPostsMedianViews ?? null,
      nonSponsoredPostsMedianLikes: raw.nonSponsoredPostsMedianLikes ?? null,

      // sanitized for brand role
      providerRaw: safeProviderRaw || null,

      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null,
    };
  });
}

function buildMediaKitResponse(docOrObj, socialProfilesSnapshot = []) {
  const mediaKit = sanitizeMediaKit(docOrObj);

  mediaKit.socialProfiles = socialProfilesSnapshot;

  // optional alias if frontend wants a clearer field name
  mediaKit.influencerReports = socialProfilesSnapshot;

  const primaryReport =
    socialProfilesSnapshot.find(
      (p) => p.provider === mediaKit.primaryPlatform
    ) || socialProfilesSnapshot[0] || null;

  mediaKit.primaryInfluencerReport = primaryReport;

  return mediaKit;
}

async function getModashProfilesForInfluencer(influencer) {
  if (!influencer) return [];

  const influencerObjectId = influencer?._id;
  const influencerPublicId = influencer?.influencerId;

  const orConditions = [];

  if (influencerObjectId) {
    orConditions.push({ influencer: influencerObjectId });
  }

  if (influencerPublicId) {
    orConditions.push({ influencerId: influencerPublicId });
  }

  if (orConditions.length === 0) return [];

  return Modash.find({ $or: orConditions }).lean();
}

// ------------------------------- Controllers ----------------------------

async function createByInfluencer(req, res) {
  try {
    const { influencerId } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ error: "influencerId is required in body" });
    }

    let influencer = null;

    if (mongoose.Types.ObjectId.isValid(influencerId)) {
      influencer = await Influencer.findById(influencerId);
    }

    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    const modashProfiles = await getModashProfilesForInfluencer(influencer);
    const socialProfilesSnapshot = mapModashToSocialProfiles(modashProfiles);
    const normalizedLanguages = await normalizeLanguagesForMediaKit(influencer.languages);

    const existing = await MediaKit.findOne({ influencerId });

    if (existing) {
      const refreshed = await refreshMediaKitForInfluencer(influencerId);
      const doc = refreshed || existing;

      if (socialProfilesSnapshot.length) {
        doc.socialProfiles = socialProfilesSnapshot;
        doc.markModified("socialProfiles");
      }

      doc.languages = normalizedLanguages;

      if (influencer.countryName) {
        doc.country = influencer.countryName;
      }

      if (!doc.username && influencer.primaryPlatform) {
        doc.username = pickUsername(influencer.primaryPlatform, socialProfilesSnapshot);
      }

      await doc.save();

      const responseMediaKit = buildMediaKitResponse(doc, socialProfilesSnapshot);

      return res.status(200).json({
        mediaKitId: doc.mediaKitId,
        mediaKit: responseMediaKit,
      });
    }

    let snapshot = buildSnapshotFromInfluencer(influencer);
    snapshot = normalizeSnapshotForMediaKit(snapshot, influencer);
    snapshot.languages = normalizedLanguages;

    const mediaKit = await MediaKit.create({
      influencerId,
      ...snapshot,
      username:
        snapshot.username ||
        pickUsername(influencer.primaryPlatform, socialProfilesSnapshot),
      socialProfiles: socialProfilesSnapshot,
    });

    const responseMediaKit = buildMediaKitResponse(mediaKit, socialProfilesSnapshot);

    return res.status(201).json({
      mediaKitId: mediaKit.mediaKitId,
      mediaKit: responseMediaKit,
    });
  } catch (err) {
    console.error("Create MediaKit error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Duplicate key",
        details: err.keyValue,
      });
    }

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
}

async function updateMediaKit(req, res) {
  try {
    const { mediaKitId, ...rest } = req.body || {};

    if (!mediaKitId) {
      return res.status(400).json({ error: "mediaKitId is required in body" });
    }

    const updated = await MediaKit.findOneAndUpdate(
      { mediaKitId },
      { $set: rest },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "MediaKit not found" });
    }

    return res.json({
      message: "MediaKit updated successfully",
      mediaKitId: updated.mediaKitId,
      mediaKit: sanitizeMediaKit(updated),
    });
  } catch (err) {
    console.error("Update MediaKit error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Duplicate key",
        details: err.keyValue,
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
}

async function getAllMediaKits(_req, res) {
  try {
    const docs = await MediaKit.find(
      {},
      {
        _id: 0,
        __v: 0,
        password: 0,
        passwordHash: 0,
      }
    ).lean();

    const items = await Promise.all(
      (docs || []).map(async (d) => {
        const kit = { ...d };

        if (!Array.isArray(kit.socialProfiles) || kit.socialProfiles.length === 0) {
          if (kit.influencerId && mongoose.Types.ObjectId.isValid(kit.influencerId)) {
            const influencer = await Influencer.findById(kit.influencerId).lean();

            if (influencer) {
              const modashProfiles = await getModashProfilesForInfluencer(influencer);
              kit.socialProfiles = mapModashToSocialProfiles(modashProfiles);
            } else {
              kit.socialProfiles = [];
            }
          } else {
            kit.socialProfiles = [];
          }
        } else {
          kit.socialProfiles = mapModashToSocialProfiles(kit.socialProfiles);
        }

        return kit;
      })
    );

    return res.json(items);
  } catch (err) {
    console.error("Get all MediaKits error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function syncByInfluencer(req, res) {
  try {
    const { influencerId } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ error: "influencerId is required in body" });
    }

    const updated = await refreshMediaKitForInfluencer(influencerId);

    if (!updated) {
      return res.status(404).json({ error: "MediaKit not found for this influencerId" });
    }

    return res.json({
      message: "MediaKit synced from Influencer successfully",
      mediaKitId: updated.mediaKitId,
      mediaKit: sanitizeMediaKit(updated),
    });
  } catch (err) {
    console.error("Sync MediaKit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = {
  createByInfluencer,
  updateMediaKit,
  getAllMediaKits,
  syncByInfluencer,
};