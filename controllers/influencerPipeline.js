'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const ModashProfile = require('../models/modash');
const InfluencerProfile = require('../models/youtube');
const {
  InfluencerPipeline,
  PIPELINE_STAGES,
  PIPELINE_SOURCES,
} = require('../models/influencerPipeline');
const {
  ensureCampaignAccess,
  ensureBrandCampaignAccess,
} = require('../utils/campaignAccess');
const { getThreadConversationState } = require('../services/adminEmail.service');
const CampaignInvitation = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const { InfluencerModel: Influencer } = require("../models/influencer");

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeSocialHandle(value) {
  const raw = cleanStr(value).toLowerCase();
  if (!raw) return null;

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return null;

  const socialUrlMatch = raw.match(
    /(?:instagram\.com|tiktok\.com|youtube\.com)\/(?:@)?([a-z0-9._-]+)/i
  );
  if (socialUrlMatch?.[1]) {
    return socialUrlMatch[1].replace(/^@/, "").trim().toLowerCase();
  }

  if (raw.startsWith("@")) {
    return raw.slice(1).trim().toLowerCase();
  }

  if (/^[a-z0-9._-]{2,}$/.test(raw)) {
    return raw;
  }

  return null;
}

function addHandleCandidate(set, value) {
  const normalized = normalizeSocialHandle(value);
  if (normalized) set.add(normalized);
}

function collectHandlesFromSignupPayload(value, set, parentKey = "") {
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHandlesFromSignupPayload(item, set, parentKey);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      collectHandlesFromSignupPayload(val, set, key);
    }
    return;
  }

  if (typeof value !== "string") return;

  const str = value.trim();
  if (!str) return;

  const key = String(parentKey || "").toLowerCase();

  const looksLikeHandleField =
    /handle|username|user_name|user name|instagram|youtube|tiktok|ig|yt/.test(key);

  const looksLikeSocialUrl =
    /instagram\.com|tiktok\.com|youtube\.com|youtu\.be/i.test(str);

  const looksLikeAtHandle = str.trim().startsWith("@");

  if (looksLikeHandleField || looksLikeSocialUrl || looksLikeAtHandle) {
    addHandleCandidate(set, str);
  }
}

function influencerMatchesAnyHandle(influencerDoc, targetHandles) {
  const foundHandles = new Set();

  collectHandlesFromSignupPayload(influencerDoc?.page1 || [], foundHandles);
  collectHandlesFromSignupPayload(influencerDoc?.page2 || [], foundHandles);
  collectHandlesFromSignupPayload(influencerDoc?.page3 || [], foundHandles);

  for (const handle of targetHandles) {
    if (foundHandles.has(handle)) return true;
  }

  return false;
}

async function resolveInfluencerFromPipelineRow(row) {
  if (
    row?.linkedInfluencerId &&
    mongoose.Types.ObjectId.isValid(String(row.linkedInfluencerId))
  ) {
    const linked = await Influencer.findById(row.linkedInfluencerId)
      .select("_id name email proxyEmail page1 page2 page3")
      .lean();

    if (linked) return linked;
  }

  const email = cleanStr(row?.email).toLowerCase();
  if (email) {
    const byEmail = await Influencer.findOne({
      $or: [{ email }, { proxyEmail: email }],
    })
      .select("_id name email proxyEmail page1 page2 page3")
      .lean();

    if (byEmail) return byEmail;
  }

  const handleCandidates = new Set();

  addHandleCandidate(handleCandidates, row?.handle);
  addHandleCandidate(handleCandidates, row?.username);

  let modashDoc = null;

  if (
    row?.sourceType === PIPELINE_SOURCES.MODASH &&
    row?.sourceRefId &&
    mongoose.Types.ObjectId.isValid(String(row.sourceRefId))
  ) {
    modashDoc = await ModashProfile.findById(row.sourceRefId)
      .select("_id userId provider username handle fullname")
      .lean();
  }

  if (!modashDoc && row?.userId) {
    modashDoc = await ModashProfile.findOne({
      userId: String(row.userId).trim(),
      ...(row?.platform ? { provider: String(row.platform).trim().toLowerCase() } : {}),
    })
      .select("_id userId provider username handle fullname")
      .lean();
  }

  addHandleCandidate(handleCandidates, modashDoc?.handle);
  addHandleCandidate(handleCandidates, modashDoc?.username);

  if (!handleCandidates.size) {
    return null;
  }

  const influencers = await Influencer.find({})
    .select("_id name email proxyEmail page1 page2 page3")
    .lean();

  const matched = influencers.find((doc) =>
    influencerMatchesAnyHandle(doc, handleCandidates)
  );

  return matched || null;
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const v of values) {
    const s = cleanStr(v);
    if (!s) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(s);
  }

  return out;
}

function cleanObject(obj = {}) {
  const out = { ...obj };

  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }

  return out;
}

function getActorAdminId(actor) {
  return actor?.adminId || actor?._id || actor?.id || null;
}

function categoryNamesFromModash(doc) {
  const out = [];
  const arr = Array.isArray(doc?.categories) ? doc.categories : [];

  for (const item of arr) {
    if (!item) continue;

    if (typeof item === 'string') {
      out.push(item);
      continue;
    }

    if (cleanStr(item.categoryName)) out.push(item.categoryName);
    if (cleanStr(item.subcategoryName)) out.push(item.subcategoryName);
  }

  return uniqStrings(out);
}

function topicNamesFromYoutube(doc) {
  const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
  const categories = Array.isArray(doc?.topicCategories) ? doc.topicCategories : [];

  return uniqStrings([...labels, ...categories]);
}

function normalizeModashDoc(doc, campaignId, actorId) {
  const links = uniqStrings([doc?.url]);
  const niche = categoryNamesFromModash(doc);

  return {
    campaignId,
    sourceType: PIPELINE_SOURCES.MODASH,
    sourceRefId: String(doc?._id || ''),
    platform: cleanStr(doc?.provider || 'other').toLowerCase() || 'other',

    name: cleanStr(doc?.fullname),
    username: cleanStr(doc?.username),
    handle: cleanStr(doc?.handle || doc?.username),
    userId: cleanStr(doc?.userId),

    followers: Number.isFinite(Number(doc?.followers)) ? Number(doc.followers) : null,
    links,
    primaryLink: cleanStr(doc?.url),
    picture: cleanStr(doc?.picture),

    niche,
    description: cleanStr(doc?.bio),
    email: '',
    phone: '',

    country: cleanStr(doc?.country),
    state: cleanStr(doc?.state),
    city: cleanStr(doc?.city),
    language:
      typeof doc?.language === 'string'
        ? cleanStr(doc.language)
        : cleanStr(doc?.language?.name || doc?.language?.code),

    engagementRate:
      Number.isFinite(Number(doc?.engagementRate)) ? Number(doc.engagementRate) : null,

    updatedByAdmin: actorId || null,
    rawSnapshot: doc,
  };
}

function normalizeYoutubeDoc(doc, campaignId, actorId) {
  const channelUrl = doc?.handle
    ? `https://www.youtube.com/${doc.handle}`
    : doc?.channelId
      ? `https://www.youtube.com/channel/${doc.channelId}`
      : '';

  return {
    campaignId,
    sourceType: PIPELINE_SOURCES.YOUTUBE,
    sourceRefId: cleanStr(doc?.handleId || doc?._id),
    platform: 'youtube',

    name: cleanStr(doc?.title),
    username: cleanStr(doc?.handle).replace(/^@/, ''),
    handle: cleanStr(doc?.handle),
    userId: cleanStr(doc?.channelId),

    followers: Number.isFinite(Number(doc?.subscriberCount))
      ? Number(doc.subscriberCount)
      : null,
    links: uniqStrings([channelUrl]),
    primaryLink: channelUrl,
    picture: cleanStr(
      doc?.thumbnails?.default?.url ||
      doc?.thumbnails?.medium?.url ||
      doc?.thumbnails?.high?.url
    ),

    niche: topicNamesFromYoutube(doc),
    description: cleanStr(doc?.description),
    email: cleanStr(doc?.email),
    phone: '',

    country: cleanStr(doc?.country),
    state: '',
    city: '',
    language: cleanStr(doc?.defaultLanguage),

    engagementRate:
      Number.isFinite(Number(doc?.engagementRateLast15))
        ? Number(doc.engagementRateLast15)
        : null,

    demographics: '',
    deliverables: '',
    rates: null,
    mediaKit: '',
    address: '',

    updatedByAdmin: actorId || null,
    rawSnapshot: doc,
  };
}

function normalizeRawUser(item, campaignId, actorId) {
  const sourceRefId =
    cleanStr(item?.sourceRefId) ||
    cleanStr(item?.userId) ||
    cleanStr(item?.handle) ||
    cleanStr(item?.username);

  return {
    campaignId,
    sourceType: PIPELINE_SOURCES.MODASH,
    sourceRefId,
    platform: cleanStr(item?.platform || item?.provider || 'other').toLowerCase() || 'other',

    name: cleanStr(item?.fullname || item?.name),
    username: cleanStr(item?.username),
    handle: cleanStr(item?.handle || item?.username),
    userId: cleanStr(item?.userId),

    followers: Number.isFinite(Number(item?.followers)) ? Number(item.followers) : null,
    links: uniqStrings([item?.url]),
    primaryLink: cleanStr(item?.url),
    picture: cleanStr(item?.picture),

    niche: uniqStrings([
      ...(Array.isArray(item?.categories) ? item.categories : []),
      item?.category,
    ]),
    description: cleanStr(item?.bio),
    email: cleanStr(item?.email),
    phone: '',

    country: cleanStr(item?.country),
    state: cleanStr(item?.state),
    city: cleanStr(item?.city),
    language: cleanStr(item?.language),

    engagementRate:
      Number.isFinite(Number(item?.engagementRate)) ? Number(item.engagementRate) : null,

    updatedByAdmin: actorId || null,
    rawSnapshot: item,
  };
}

async function ensurePipelineAccess(actor, pipelineId) {
  if (!pipelineId || !mongoose.Types.ObjectId.isValid(pipelineId)) return null;

  const row = await InfluencerPipeline.findById(pipelineId)
    .select('_id campaignId')
    .lean();

  if (!row) return null;

  const allowedCampaign = await ensureCampaignAccess(actor, row.campaignId);
  if (!allowedCampaign) return null;

  return row;
}

async function ensureManyPipelineAccess(actor, ids = []) {
  const validIds = ids
    .map((x) => cleanStr(x))
    .filter((x) => mongoose.Types.ObjectId.isValid(x));

  if (!validIds.length) return [];

  const rows = await InfluencerPipeline.find({
    _id: { $in: validIds },
  })
    .select('_id campaignId')
    .lean();

  if (rows.length !== validIds.length) {
    return null;
  }

  const campaignAccessCache = new Map();

  for (const row of rows) {
    const campaignId = cleanStr(row.campaignId);

    if (!campaignAccessCache.has(campaignId)) {
      const allowed = await ensureCampaignAccess(actor, campaignId);
      campaignAccessCache.set(campaignId, !!allowed);
    }

    if (!campaignAccessCache.get(campaignId)) {
      return null;
    }
  }

  return validIds;
}

async function buildEmailStateForRow(row, actorAdminId) {
  if (!row?.email) {
    return {
      threadId: null,
      outreachSentAt: null,
      followUp1SentAt: null,
      followUp2SentAt: null,
      replyChecked: false,
      repliedAt: null,
      replyText: '',
    };
  }

  try {
    return await getThreadConversationState({
      pipelineId: row._id,
      recipientEmail: row.email,
      actorAdminId,
    });
  } catch (error) {
    return {
      threadId: null,
      outreachSentAt: null,
      followUp1SentAt: null,
      followUp2SentAt: null,
      replyChecked: false,
      repliedAt: null,
      replyText: '',
      error: error?.message || 'Failed to derive email state',
    };
  }
}

async function attachEmailStateToRow(row, actorAdminId) {
  const emailState = await buildEmailStateForRow(row, actorAdminId);

  const outreachDate =
    emailState.outreachSentAt ||
    row.outreachDate ||
    row.createdAt ||
    null;

  const followUp1SentAt =
    emailState.followUp1SentAt ||
    row.followUp1SentAt ||
    null;

  const followUp2SentAt =
    emailState.followUp2SentAt ||
    row.followUp2SentAt ||
    null;

  const repliedAt =
    emailState.repliedAt ||
    row.repliedAt ||
    null;

  return {
    ...row,
    emailState,
    outreachDate,
    outreached: Boolean(row.outreached || emailState.outreachSentAt),
    followUp1SentAt,
    followUp2SentAt,
    replyChecked: Boolean(row.replyChecked || emailState.replyChecked || repliedAt),
    repliedAt,
    replyText: emailState.replyText || row.replyText || "",
  };
}

async function attachEmailStateToRows(rows, actorAdminId) {
  return Promise.all(rows.map((row) => attachEmailStateToRow(row, actorAdminId)));
}

exports.bulkAddToOutreach = async (req, res) => {
  try {
    const body = req.body || {};
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const campaignId = cleanStr(body.campaignId);

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: 'Valid campaignId is required' });
    }

    const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: 'You are not allowed to access this campaign' });
    }

    const modashIds = Array.isArray(body.modashIds) ? body.modashIds : [];
    const youtubeHandleIds = Array.isArray(body.youtubeHandleIds) ? body.youtubeHandleIds : [];
    const rawUsers = Array.isArray(body.rawUsers) ? body.rawUsers : [];

    const ops = [];

    if (modashIds.length) {
      const docs = await ModashProfile.find({
        _id: { $in: modashIds.filter((x) => mongoose.Types.ObjectId.isValid(x)) },
      }).lean();

      for (const doc of docs) {
        const normalized = normalizeModashDoc(doc, campaignId, actorId);

        ops.push({
          updateOne: {
            filter: {
              campaignId,
              sourceType: PIPELINE_SOURCES.MODASH,
              sourceRefId: normalized.sourceRefId,
            },
            update: {
              $set: {
                ...normalized,
                status: PIPELINE_STAGES.OUTREACH,
                updatedByAdmin: actorId || null,
              },
              $setOnInsert: {
                createdByAdmin: actorId || null,
                outreachDate: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (youtubeHandleIds.length) {
      const docs = await InfluencerProfile.find({
        handleId: { $in: youtubeHandleIds.map((x) => cleanStr(x)).filter(Boolean) },
      }).lean();

      for (const doc of docs) {
        const normalized = normalizeYoutubeDoc(doc, campaignId, actorId);

        ops.push({
          updateOne: {
            filter: {
              campaignId,
              sourceType: PIPELINE_SOURCES.YOUTUBE,
              sourceRefId: normalized.sourceRefId,
            },
            update: {
              $set: {
                ...normalized,
                status: PIPELINE_STAGES.OUTREACH,
                updatedByAdmin: actorId || null,
              },
              $setOnInsert: {
                createdByAdmin: actorId || null,
              },
            },
            upsert: true,
          },
        });
      }
    }

    for (const item of rawUsers) {
      const normalized = normalizeRawUser(item, campaignId, actorId);
      if (!normalized.sourceRefId) continue;

      ops.push({
        updateOne: {
          filter: {
            campaignId,
            sourceType: normalized.sourceType,
            sourceRefId: normalized.sourceRefId,
          },
          update: {
            $set: {
              ...normalized,
              status: PIPELINE_STAGES.OUTREACH,
              updatedByAdmin: actorId || null,
            },
            $setOnInsert: {
              createdByAdmin: actorId || null,
            },
          },
          upsert: true,
        },
      });
    }

    if (!ops.length) {
      return res.status(400).json({ error: 'No influencers supplied' });
    }

    const result = await InfluencerPipeline.bulkWrite(ops, { ordered: false });

    return res.json({
      success: true,
      message: 'Influencers added to outreach pipeline',
      added: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
    });
  } catch (err) {
    console.error('[bulkAddToOutreach] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.listPipeline = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const campaignId = cleanStr(req.query.campaignId);
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }

    const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: 'You are not allowed to access this campaign' });
    }

    const filter = { campaignId };

    if (cleanStr(req.query.status)) filter.status = cleanStr(req.query.status);
    if (cleanStr(req.query.platform)) {
      filter.platform = cleanStr(req.query.platform).toLowerCase();
    }

    const q = cleanStr(req.query.q);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { name: rx },
        { username: rx },
        { handle: rx },
        { email: rx },
        { description: rx },
        { niche: rx },
      ];
    }

    const [total, rows] = await Promise.all([
      InfluencerPipeline.countDocuments(filter),
      InfluencerPipeline.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const results = await attachEmailStateToRows(rows, actorId);

    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      results,
    });
  } catch (err) {
    console.error('[listPipeline] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updateOutreach = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const update = cleanObject({
      email: cleanStr(body.email),
      phone: cleanStr(body.phone),
      description: cleanStr(body.description),
      imeRating: cleanStr(body.imeRating),
      nicheFitNotes: cleanStr(body.nicheFitNotes),
      engagementNotes: cleanStr(body.engagementNotes),
      redFlags: cleanStr(body.redFlags),
      internalNotes: cleanStr(body.internalNotes),
      updatedByAdmin: actorId || null,
    });

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[updateOutreach] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.markOutreachSent = async (req, res) => {
  try {
    const actor = req.admin;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const allowedIds = await ensureManyPipelineAccess(actor, ids);

    if (allowedIds === null) {
      return res.status(403).json({ error: 'You are not allowed to update one or more rows' });
    }

    if (!allowedIds.length) {
      return res.status(400).json({ error: 'ids are required' });
    }

    const now = new Date();

    await InfluencerPipeline.updateMany(
      { _id: { $in: allowedIds } },
      {
        $set: {
          outreached: true,
          outreachDate: now,
          updatedAt: now,
        },
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[markOutreachSent] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.markFollowUp = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const doc = await InfluencerPipeline.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({
      success: true,
      message: 'Follow-up state is derived from email thread messages',
      data,
    });
  } catch (err) {
    console.error('[markFollowUp] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.saveReplyAndMoveToRoster = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const row = await InfluencerPipeline.findById(id).lean();
    if (!row) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const emailState = await buildEmailStateForRow(row, actorId);

    if (!emailState.replyChecked) {
      return res.status(400).json({
        success: false,
        error: 'Cannot move to roster until a reply is received',
        emailState,
      });
    }

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          status: PIPELINE_STAGES.ROSTER,
          repliedAt: emailState.repliedAt || new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[saveReplyAndMoveToRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updateRoster = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          demographics: cleanStr(body.demographics),
          engagementRate: Number.isFinite(Number(body.engagementRate))
            ? Number(body.engagementRate)
            : null,
          deliverables: cleanStr(body.deliverables),
          rates: Number.isFinite(Number(body.rates)) ? Number(body.rates) : null,
          mediaKit: cleanStr(body.mediaKit),
          address: cleanStr(body.address),
          email: cleanStr(body.email),
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[updateRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.moveToPitch = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: { status: PIPELINE_STAGES.PITCH } },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[moveToPitch] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updatePitch = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          country: cleanStr(body.country),
          additionalInfo: cleanStr(body.additionalInfo),
          selectionReason: cleanStr(body.selectionReason),
          goodFit: Boolean(body.goodFit),
          rateUsd: Number.isFinite(Number(body.rateUsd)) ? Number(body.rateUsd) : null,
          ourFeePct: Number.isFinite(Number(body.ourFeePct)) ? Number(body.ourFeePct) : null,
          comments: cleanStr(body.comments),
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[updatePitch] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.generatePortalLink = async (req, res) => {
  try {
    const actor = req.admin;
    const campaignId = cleanStr(req.params.campaignId);

    const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: 'You are not allowed to access this campaign' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const portalUrl = `${process.env.BRAND_PORTAL_BASE_URL || 'https://collabglam.cloud/brand-portal'
      }/${token}`;

    await InfluencerPipeline.updateMany(
      {
        campaignId,
        status: { $in: [PIPELINE_STAGES.PITCH, PIPELINE_STAGES.SHORTLISTED] },
      },
      {
        $set: {
          portal: {
            token,
            url: portalUrl,
            generatedAt: new Date(),
            sharedByAdminId: getActorAdminId(req.admin),
          },
        },
      }
    );

    return res.json({
      success: true,
      token,
      url: portalUrl,
    });
  } catch (err) {
    console.error('[generatePortalLink] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.addMilestone = async (req, res) => {
  try {
    const id = cleanStr(req.body?.id);
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const update = {
      $push: {
        milestones: {
          title: cleanStr(body.title),
          amount: Number.isFinite(Number(body.amount)) ? Number(body.amount) : null,
          deliverable: cleanStr(body.deliverable),
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          status: 'released',
          releasedAt: new Date(),
        },
      },
    };

    const doc = await InfluencerPipeline.findByIdAndUpdate(id, update, { new: true }).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[addMilestone] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.getPipelineById = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.params.id);

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to access this row' });
    }

    const doc = await InfluencerPipeline.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[getPipelineById] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.moveToRoster = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);

    const allowedRow = await ensurePipelineAccess(actor, id);
    if (!allowedRow) {
      return res.status(403).json({ error: 'You are not allowed to update this row' });
    }

    const row = await InfluencerPipeline.findById(id).lean();
    if (!row) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const emailState = await buildEmailStateForRow(row, actorId);

    if (!emailState.replyChecked) {
      return res.status(400).json({
        success: false,
        error: 'Cannot move to roster until a reply is received',
        emailState,
      });
    }

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          status: PIPELINE_STAGES.ROSTER,
          repliedAt: emailState.repliedAt || new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToRow(doc, actorId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[moveToRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.createPipelineRow = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = actor?.adminId || null;
    const body = req.body || {};

    const campaignId = cleanStr(body.campaignId);
    const requestedStatus = cleanStr(body.status).toLowerCase();

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: 'Valid campaignId is required' });
    }

    const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: 'You are not allowed to access this campaign' });
    }

    const allowedStatuses = [
      PIPELINE_STAGES.OUTREACH,
      PIPELINE_STAGES.ROSTER,
      PIPELINE_STAGES.PITCH,
    ];

    const status = allowedStatuses.includes(requestedStatus)
      ? requestedStatus
      : PIPELINE_STAGES.OUTREACH;

    const name = cleanStr(body.name);
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const links = Array.isArray(body.links)
      ? uniqStrings(body.links)
      : uniqStrings(String(body.links || '').split(','));

    const niche = Array.isArray(body.niche)
      ? uniqStrings(body.niche)
      : uniqStrings(String(body.niche || '').split(','));

    const primaryLink =
      cleanStr(body.primaryLink) ||
      (links.length ? links[0] : '');

    const manualSourceType = PIPELINE_SOURCES.MANUAL || 'manual';
    const sourceRefId = `manual_${new mongoose.Types.ObjectId().toString()}`;

    const doc = await InfluencerPipeline.create({
      campaignId,
      status,

      sourceType: manualSourceType,
      sourceRefId,
      platform: cleanStr(body.platform || 'other').toLowerCase() || 'other',

      name,
      username: cleanStr(body.username),
      handle: cleanStr(body.handle),
      userId: cleanStr(body.userId),

      followers:
        body.followers === '' || body.followers === null || body.followers === undefined
          ? null
          : Number.isFinite(Number(body.followers))
            ? Number(body.followers)
            : null,

      links,
      primaryLink,
      picture: cleanStr(body.picture),

      niche,
      email: cleanStr(body.email),
      phone: cleanStr(body.phone),
      country: cleanStr(body.country),
      state: cleanStr(body.state),
      city: cleanStr(body.city),
      language: cleanStr(body.language),

      outreachDate:
        status === PIPELINE_STAGES.OUTREACH
          ? body.outreachDate
            ? new Date(body.outreachDate)
            : new Date()
          : null,
      outreached: typeof body.outreached === 'boolean' ? body.outreached : false,
      followUp1SentAt: body.followUp1SentAt ? new Date(body.followUp1SentAt) : null,
      followUp2SentAt: body.followUp2SentAt ? new Date(body.followUp2SentAt) : null,
      replyText: cleanStr(body.replyText),

      demographics: cleanStr(body.demographics),
      engagementRate:
        body.engagementRate === '' || body.engagementRate === null || body.engagementRate === undefined
          ? null
          : Number.isFinite(Number(body.engagementRate))
            ? Number(body.engagementRate)
            : null,
      deliverables: cleanStr(body.deliverables),
      rates:
        body.rates === '' || body.rates === null || body.rates === undefined
          ? null
          : Number.isFinite(Number(body.rates))
            ? Number(body.rates)
            : null,
      mediaKit: cleanStr(body.mediaKit),
      address: cleanStr(body.address),

      additionalInfo: cleanStr(body.additionalInfo),
      selectionReason: cleanStr(body.selectionReason),
      goodFit: typeof body.goodFit === 'boolean' ? body.goodFit : false,
      rateUsd:
        body.rateUsd === '' || body.rateUsd === null || body.rateUsd === undefined
          ? null
          : Number.isFinite(Number(body.rateUsd))
            ? Number(body.rateUsd)
            : null,
      ourFeePct:
        body.ourFeePct === '' || body.ourFeePct === null || body.ourFeePct === undefined
          ? null
          : Number.isFinite(Number(body.ourFeePct))
            ? Number(body.ourFeePct)
            : null,
      comments: cleanStr(body.comments),

      createdByAdmin: actorId,
      updatedByAdmin: actorId,

      rawSnapshot: {
        type: 'manual_create',
        createdFromUi: true,
        body,
      },
    });

    return res.json({
      success: true,
      message: 'Pipeline row created successfully',
      data: doc,
    });
  } catch (err) {
    console.error('[createPipelineRow] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getBrandPitchSheetByCampaign = async (req, res) => {
  try {
    const campaignId = cleanStr(req.query.campaignId);
    const brandId = cleanStr(req.query.brandId || req.body?.brandId);
    const actor = req.admin || null;
    const isAdminViewer = !!getActorAdminId(actor);

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: 'Valid campaignId is required' });
    }

    if (isAdminViewer) {
      const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
      if (!allowedCampaign) {
        return res.status(403).json({ error: 'You are not allowed to access this pitch sheet' });
      }
    } else {
      if (!brandId) {
        return res.status(401).json({ error: 'Brand login required' });
      }

      const allowedCampaign = await ensureBrandCampaignAccess(brandId, campaignId);
      if (!allowedCampaign) {
        return res.status(403).json({ error: 'You are not allowed to access this pitch sheet' });
      }
    }

    const rows = await InfluencerPipeline.find({
      campaignId,
      status: PIPELINE_STAGES.PITCH,
    })
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      viewerType: isAdminViewer ? 'admin' : 'brand',
      data: {
        campaignId,
        items: rows.map((row) => ({
          _id: row._id,
          campaignId: row.campaignId,
          name: row.name,
          followers: row.followers,
          primaryLink: row.primaryLink,
          links: row.links,
          niche: row.niche,
          country: row.country,
          additionalInfo: row.additionalInfo,
          selectionReason: row.selectionReason,
          ...(isAdminViewer ? {} : { goodFit: row.goodFit }),
          rateUsd: row.rateUsd,
          ourFeePct: row.ourFeePct,
          comments: row.comments,
        })),
      },
    });
  } catch (err) {
    console.error('[getBrandPitchSheetByCampaign] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateBrandPitchGoodFit = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);
    const brandId = cleanStr(req.body?.brandId);
    const goodFit = !!req.body?.goodFit;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid pitch id is required' });
    }

    if (!brandId) {
      return res.status(401).json({ error: 'Brand login required' });
    }

    const row = await InfluencerPipeline.findById(id).lean();
    if (!row) {
      return res.status(404).json({ error: 'Pitch row not found' });
    }

    if (String(row.status).toLowerCase() !== PIPELINE_STAGES.PITCH) {
      return res.status(400).json({ error: 'This row is not in pitch stage' });
    }

    const allowedCampaign = await ensureBrandCampaignAccess(brandId, row.campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: 'You are not allowed to update this pitch sheet' });
    }

    const updated = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          goodFit,
        },
      },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: 'Good fit updated successfully',
      data: updated,
    });
  } catch (err) {
    console.error('[updateBrandPitchGoodFit] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.sendCampaignInvitationFromPitch = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);

    const campaignId = cleanStr(req.body?.campaignId);
    const pipelineId = cleanStr(req.body?.pipelineId);

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: "Valid campaignId is required" });
    }

    if (!pipelineId || !mongoose.Types.ObjectId.isValid(pipelineId)) {
      return res.status(400).json({ error: "Valid pipelineId is required" });
    }

    const allowedCampaign = await ensureCampaignAccess(actor, campaignId);
    if (!allowedCampaign) {
      return res.status(403).json({ error: "You are not allowed to access this campaign" });
    }

    const [campaign, row] = await Promise.all([
      Campaign.findById(campaignId)
        .select("_id brandId campaignTitle")
        .lean(),
      InfluencerPipeline.findOne({
        _id: pipelineId,
        campaignId,
        status: PIPELINE_STAGES.PITCH,
      }).lean(),
    ]);

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (!row) {
      return res.status(404).json({ error: "Pitch row not found" });
    }

    const influencer = await resolveInfluencerFromPipelineRow(row);

    if (!influencer) {
      return res.status(404).json({
        error: "Influencer signup not found from email/handle/modash username",
      });
    }

    const invitation = await CampaignInvitation.findOneAndUpdate(
      {
        brandId: campaign.brandId,
        campaignId: campaign._id,
        influencerId: influencer._id,
      },
      {
        $setOnInsert: {
          brandId: campaign.brandId,
          campaignId: campaign._id,
          influencerId: influencer._id,
          createdByAdminId:
            actorId && mongoose.Types.ObjectId.isValid(String(actorId))
              ? new mongoose.Types.ObjectId(actorId)
              : null,
        },
        $set: {
          platform: cleanStr(row.platform).toLowerCase() || undefined,
          handle: cleanStr(row.handle) || undefined,
          modashUserId: cleanStr(row.userId) || undefined,
          emailTo: influencer.email || cleanStr(row.email).toLowerCase() || null,
          status: "sent",
          sentAt: new Date(),
          failedAt: null,
          failReason: null,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

const hasInvited = ["sent", "accepted", "reject"].includes(invitation.status);

await InfluencerPipeline.updateOne(
  { _id: row._id },
  {
    $set: {
      linkedInfluencerId: influencer._id,
      campaignInvitationId: invitation._id,
      campaignInvitationStatus: invitation.status,
      campaignInvitationSentAt: invitation.sentAt || new Date(),
      hasInvited,
      hasInvitedAt: hasInvited ? (invitation.sentAt || new Date()) : null,
      updatedByAdmin: actorId || null,
    },
  }
);

    return res.json({
      success: true,
      message: "Campaign invitation created successfully",
      data: {
        pipelineId: String(row._id),
        influencerId: String(influencer._id),
        invitationId: String(invitation._id),
        influencerName: influencer.name || "",
        influencerEmail: influencer.email || "",
        status: invitation.status,
        sentAt: invitation.sentAt,
        hasInvited
      },
    });
  } catch (err) {
    console.error("[sendCampaignInvitationFromPitch] Error:", err);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
};