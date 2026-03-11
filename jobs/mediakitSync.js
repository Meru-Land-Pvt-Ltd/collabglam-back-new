const mongoose = require("mongoose");
const { InfluencerModel: Influencer } = require("../models/influencer");
const MediaKit = require("../models/mediaKit");
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

// ------------------------------- Sync Job --------------------------------

async function refreshMediaKitForInfluencer(influencerId) {
  if (!influencerId) return null;

  let influencer = null;

  if (mongoose.Types.ObjectId.isValid(influencerId)) {
    influencer = await Influencer.findById(influencerId);
  }

  if (!influencer) return null;

  const mediaKit = await MediaKit.findOne({ influencerId });
  if (!mediaKit) return null;

  let snapshot = buildSnapshotFromInfluencer(influencer);
  snapshot = normalizeSnapshotForMediaKit(snapshot, influencer);

  const normalizedLanguages = await normalizeLanguagesForMediaKit(influencer.languages);
  const modashProfiles = await getModashProfilesForInfluencer(influencer);
  const socialProfilesSnapshot = mapModashToSocialProfiles(modashProfiles);

  // avoid overwriting protected identity linkage
  delete snapshot.influencerId;
  delete snapshot.mediaKitId;
  delete snapshot._id;
  delete snapshot.socialProfiles;

  Object.assign(mediaKit, snapshot);

  mediaKit.languages = normalizedLanguages;
  mediaKit.socialProfiles = socialProfilesSnapshot;

  if (influencer.countryName) {
    mediaKit.country = influencer.countryName;
  }

  if (!mediaKit.username && influencer.primaryPlatform) {
    mediaKit.username = pickUsername(
      influencer.primaryPlatform,
      socialProfilesSnapshot
    );
  }

  await mediaKit.save();
  return mediaKit;
}

module.exports = {
  refreshMediaKitForInfluencer,
};