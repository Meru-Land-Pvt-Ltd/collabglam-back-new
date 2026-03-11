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

function mapModashToSocialProfiles(modashDocs = []) {
  if (!Array.isArray(modashDocs)) return [];

  return modashDocs.map((p) => ({
    provider: p.provider || null,
    username: p.username || p.handle || null,
    fullname: p.fullname || null,
    url: p.url || null,
    picture: p.picture || null,

    followers: p.followers ?? null,
    engagements: p.engagements ?? null,
    engagementRate: p.engagementRate ?? null,
    averageViews: p.averageViews ?? null,

    stats: p.stats || null,
    categories: Array.isArray(p.categories) ? p.categories : [],

    recentPosts: Array.isArray(p.recentPosts) ? p.recentPosts : [],
    popularPosts: Array.isArray(p.popularPosts) ? p.popularPosts : [],
    hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
    mentions: Array.isArray(p.mentions) ? p.mentions : [],
    brandAffinity: Array.isArray(p.brandAffinity) ? p.brandAffinity : [],
    lookalikes: Array.isArray(p.lookalikes) ? p.lookalikes : [],
    sponsoredPosts: Array.isArray(p.sponsoredPosts) ? p.sponsoredPosts : [],

    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  }));
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
      }

      doc.languages = normalizedLanguages;

      if (influencer.countryName) {
        doc.country = influencer.countryName;
      }

      if (!doc.username && influencer.primaryPlatform) {
        doc.username = pickUsername(influencer.primaryPlatform, socialProfilesSnapshot);
      }

      await doc.save();

      return res.status(200).json({
        mediaKitId: doc.mediaKitId,
        mediaKit: sanitizeMediaKit(doc),
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

    return res.status(201).json({
      mediaKitId: mediaKit.mediaKitId,
      mediaKit: sanitizeMediaKit(mediaKit),
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