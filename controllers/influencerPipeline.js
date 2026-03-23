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

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
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

function categoryNamesFromModash(doc) {
  const out = [];
  const arr = Array.isArray(doc?.categories) ? doc.categories : [];

  for (const item of arr) {
    if (!item) continue;
    if (typeof item === 'string') out.push(item);
    else {
      if (cleanStr(item.categoryName)) out.push(item.categoryName);
      if (cleanStr(item.subcategoryName)) out.push(item.subcategoryName);
    }
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

    createdByAdmin: actorId || null,
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

    followers: Number.isFinite(Number(doc?.subscriberCount)) ? Number(doc.subscriberCount) : null,
    links: uniqStrings([channelUrl]),
    primaryLink: channelUrl,
    picture:
      cleanStr(
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

    createdByAdmin: actorId || null,
    updatedByAdmin: actorId || null,
    rawSnapshot: doc,
  };
}

exports.bulkAddToOutreach = async (req, res) => {
  try {
    const body = req.body || {};
    const actorId = req.admin?.adminId || null;
    const campaignId = cleanStr(body.campaignId);

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: 'Valid campaignId is required' });
    }

    const modashIds = Array.isArray(body.modashIds) ? body.modashIds : [];
    const youtubeHandleIds = Array.isArray(body.youtubeHandleIds) ? body.youtubeHandleIds : [];
    const rawUsers = Array.isArray(body.rawUsers) ? body.rawUsers : [];

    const ops = [];
    let added = 0;
    let updated = 0;

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

    // for live /modash/users results that do not exist in ModashProfile yet
    for (const item of rawUsers) {
      const sourceRefId =
        cleanStr(item?.sourceRefId) ||
        cleanStr(item?.userId) ||
        cleanStr(item?.handle) ||
        cleanStr(item?.username);

      const normalized = {
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

        niche: uniqStrings([...(Array.isArray(item?.categories) ? item.categories : []), item?.category]),
        description: cleanStr(item?.bio),
        email: cleanStr(item?.email),
        phone: '',

        country: cleanStr(item?.country),
        state: cleanStr(item?.state),
        city: cleanStr(item?.city),
        language: cleanStr(item?.language),

        engagementRate:
          Number.isFinite(Number(item?.engagementRate)) ? Number(item.engagementRate) : null,

        createdByAdmin: actorId || null,
        updatedByAdmin: actorId || null,
        rawSnapshot: item,
      };

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
    added = result.upsertedCount || 0;
    updated = result.modifiedCount || 0;

    return res.json({
      success: true,
      message: 'Influencers added to outreach pipeline',
      added,
      updated,
    });
  } catch (err) {
    console.error('[bulkAddToOutreach] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.listPipeline = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (cleanStr(req.query.campaignId)) filter.campaignId = req.query.campaignId;
    if (cleanStr(req.query.status)) filter.status = cleanStr(req.query.status);
    if (cleanStr(req.query.platform)) filter.platform = cleanStr(req.query.platform).toLowerCase();

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

    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      results: rows,
    });
  } catch (err) {
    console.error('[listPipeline] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updateOutreach = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);
    const actorId = req.admin?.adminId || null;
    const body = req.body || {};

    const update = {
      email: cleanStr(body.email),
      phone: cleanStr(body.phone),
      description: cleanStr(body.description),
      imeRating: cleanStr(body.imeRating),
      nicheFitNotes: cleanStr(body.nicheFitNotes),
      engagementNotes: cleanStr(body.engagementNotes),
      redFlags: cleanStr(body.redFlags),
      internalNotes: cleanStr(body.internalNotes),
      updatedByAdmin: actorId,
    };

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[updateOutreach] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.markOutreachSent = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const now = new Date();

    await InfluencerPipeline.updateMany(
      { _id: { $in: ids } },
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
    const id = cleanStr(req.params.id);
    const step = cleanStr(req.body?.step); // 1 or 2
    const set = step === '2'
      ? { followUp2SentAt: new Date() }
      : { followUp1SentAt: new Date() };

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: set },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[markFollowUp] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.saveReplyAndMoveToRoster = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);
    const replyText = cleanStr(req.body?.replyText);

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      {
        $set: {
          replyText,
          repliedAt: new Date(),
          status: PIPELINE_STAGES.ROSTER,
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[saveReplyAndMoveToRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updateRoster = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);
    const body = req.body || {};

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
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[updateRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.moveToPitch = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: { status: PIPELINE_STAGES.PITCH } },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[moveToPitch] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.updatePitch = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);
    const body = req.body || {};

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
    );

    if (!doc) return res.status(404).json({ error: 'Record not found' });
    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[updatePitch] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.generatePortalLink = async (req, res) => {
  try {
    const campaignId = cleanStr(req.params.campaignId);
    const token = crypto.randomBytes(24).toString('hex');
    const portalUrl = `${process.env.BRAND_PORTAL_BASE_URL || 'https://collabglam.cloud/brand-portal'}/${token}`;

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
            sharedByAdminId: req.admin?.adminId || null,
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
    const id = cleanStr(req.params.id);
    const body = req.body || {};

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

    const doc = await InfluencerPipeline.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ error: 'Record not found' });

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[addMilestone] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.getPipelineById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const doc = await InfluencerPipeline.findById(id).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[getPipelineById] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

exports.moveToRoster = async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();

    const doc = await InfluencerPipeline.findByIdAndUpdate(
      id,
      { $set: { status: 'roster' } },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[moveToRoster] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};