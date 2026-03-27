'use strict';

const mongoose = require('mongoose');
const { BrandNetwork } = require('../models/brandNetwork');

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function cleanObject(obj = {}) {
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
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

function getActorAdminId(actor) {
  return actor?.adminId || actor?._id || actor?.id || null;
}

function isValidObjectId(id) {
  return !!id && mongoose.Types.ObjectId.isValid(String(id));
}

function toNullableNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizePlanType(value) {
  const v = cleanStr(value).toLowerCase();

  if (['trial', 'trial pack', 'trial_pack', 'trialpack'].includes(v)) {
    return 'trial_pack';
  }

  if (['subscription', 'subscribed'].includes(v)) {
    return 'subscription';
  }

  return undefined;
}

function normalizeSubscriptionStatus(value) {
  const v = cleanStr(value).toLowerCase();

  if (['trial active', 'trial_active'].includes(v)) return 'trial_active';
  if (['active'].includes(v)) return 'active';
  if (['expired'].includes(v)) return 'expired';
  if (['cancelled', 'canceled'].includes(v)) return 'cancelled';

  return undefined;
}

function normalizePlatforms(value) {
  const raw = Array.isArray(value)
    ? value
    : cleanStr(value)
      ? String(value).split(',')
      : [];

  return uniqStrings(
    raw.map((item) => {
      const v = cleanStr(item).toLowerCase();

      if (['ig', 'instagram'].includes(v)) return 'instagram';
      if (['yt', 'youtube'].includes(v)) return 'youtube';
      if (['tt', 'tiktok', 'tik tok'].includes(v)) return 'tiktok';
      if (['multiple', 'multi'].includes(v)) return 'multiple';

      return '';
    })
  ).filter(Boolean);
}

function normalizeInfluencerSize(value) {
  const v = cleanStr(value).toLowerCase();

  if (['nano'].includes(v)) return 'nano';
  if (['micro'].includes(v)) return 'micro';
  if (['mid', 'mid-tier', 'mid tier'].includes(v)) return 'mid';
  if (['macro'].includes(v)) return 'macro';
  if (['celebrity'].includes(v)) return 'celebrity';

  return undefined;
}

function normalizeContentType(value) {
  const v = cleanStr(value).toLowerCase();

  if (['reel', 'reels'].includes(v)) return 'reel';
  if (['post', 'posts'].includes(v)) return 'post';
  if (['story', 'stories'].includes(v)) return 'story';
  if (['video', 'videos'].includes(v)) return 'video';
  if (['mix', 'mixed'].includes(v)) return 'mix';

  return undefined;
}

function normalizeStringArray(value) {
  return uniqStrings(
    Array.isArray(value)
      ? value
      : cleanStr(value)
        ? String(value).split(',')
        : []
  );
}

function resolveTimelineDates(body = {}) {
  const startDate =
    body?.campaignTimeline?.startDate !== undefined
      ? toNullableDate(body.campaignTimeline.startDate)
      : body.startDate !== undefined
        ? toNullableDate(body.startDate)
        : undefined;

  const endDate =
    body?.campaignTimeline?.endDate !== undefined
      ? toNullableDate(body.campaignTimeline.endDate)
      : body.endDate !== undefined
        ? toNullableDate(body.endDate)
        : undefined;

  return { startDate, endDate };
}

exports.createBrandNetworkRow = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const brandName = cleanStr(body.brandName);
    if (!brandName) {
      return res.status(400).json({ error: 'brandName is required' });
    }

    const planType = normalizePlanType(body.planType);
    const subscriptionStatus = normalizeSubscriptionStatus(body.subscriptionStatus);
    const influencerSize = normalizeInfluencerSize(body.influencerSize);
    const contentType = normalizeContentType(body.contentType);
    const platforms = normalizePlatforms(body.platforms);
    const targetRegions = normalizeStringArray(body.targetRegions);
    const { startDate, endDate } = resolveTimelineDates(body);

    const payload = cleanObject({
      sourceOutreachId: isValidObjectId(body.sourceOutreachId) ? body.sourceOutreachId : null,
      brandName,
      website: cleanStr(body.website),
      contacts: cleanStr(body.contacts),
      employeeCount: toNullableNumber(body.employeeCount),
      monthlyBudget: toNullableNumber(body.monthlyBudget),
      targetRegions,
      platforms,
      influencerCategory: cleanStr(body.influencerCategory),
      numberOfInfluencers: toNullableNumber(body.numberOfInfluencers),
      campaignRequirement: cleanStr(body.campaignRequirement),
      notes: cleanStr(body.notes),
      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    if (planType) payload.planType = planType;
    if (subscriptionStatus) payload.subscriptionStatus = subscriptionStatus;
    if (influencerSize) payload.influencerSize = influencerSize;
    if (contentType) payload.contentType = contentType;

    if (startDate !== undefined || endDate !== undefined) {
      payload.campaignTimeline = {
        startDate: startDate ?? null,
        endDate: endDate ?? null,
      };
    }

    const doc = await BrandNetwork.create(payload);

    return res.json({
      success: true,
      message: 'Brand network row created successfully',
      data: doc,
    });
  } catch (err) {
    console.error('[createBrandNetworkRow] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.listBrandNetwork = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const filter = {};

    const q = cleanStr(req.query.q);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { brandName: rx },
        { website: rx },
        { contacts: rx },
        { influencerCategory: rx },
        { campaignRequirement: rx },
        { notes: rx },
      ];
    }

    const planType = normalizePlanType(req.query.planType);
    if (planType) {
      filter.planType = planType;
    }

    const subscriptionStatus = normalizeSubscriptionStatus(req.query.subscriptionStatus);
    if (subscriptionStatus) {
      filter.subscriptionStatus = subscriptionStatus;
    }

    const influencerSize = normalizeInfluencerSize(req.query.influencerSize);
    if (influencerSize) {
      filter.influencerSize = influencerSize;
    }

    const contentType = normalizeContentType(req.query.contentType);
    if (contentType) {
      filter.contentType = contentType;
    }

    const platform = cleanStr(req.query.platform).toLowerCase();
    if (platform) {
      filter.platforms = platform;
    }

    const [total, rows] = await Promise.all([
      BrandNetwork.countDocuments(filter),
      BrandNetwork.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      hasNext: page * limit < total,
      results: rows,
    });
  } catch (err) {
    console.error('[listBrandNetwork] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getBrandNetworkById = async (req, res) => {
  try {
    const id = cleanStr(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const doc = await BrandNetwork.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    return res.json({
      success: true,
      data: doc,
    });
  } catch (err) {
    console.error('[getBrandNetworkById] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateBrandNetwork = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};
    const id = cleanStr(body.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const $set = cleanObject({
      brandName: body.brandName !== undefined ? cleanStr(body.brandName) : undefined,
      website: body.website !== undefined ? cleanStr(body.website) : undefined,
      contacts: body.contacts !== undefined ? cleanStr(body.contacts) : undefined,
      employeeCount:
        body.employeeCount !== undefined ? toNullableNumber(body.employeeCount) : undefined,
      monthlyBudget:
        body.monthlyBudget !== undefined ? toNullableNumber(body.monthlyBudget) : undefined,
      targetRegions:
        body.targetRegions !== undefined ? normalizeStringArray(body.targetRegions) : undefined,
      platforms:
        body.platforms !== undefined ? normalizePlatforms(body.platforms) : undefined,
      influencerCategory:
        body.influencerCategory !== undefined ? cleanStr(body.influencerCategory) : undefined,
      numberOfInfluencers:
        body.numberOfInfluencers !== undefined
          ? toNullableNumber(body.numberOfInfluencers)
          : undefined,
      campaignRequirement:
        body.campaignRequirement !== undefined
          ? cleanStr(body.campaignRequirement)
          : undefined,
      notes: body.notes !== undefined ? cleanStr(body.notes) : undefined,
      updatedByAdmin: actorId || null,
    });

    const $unset = {};

    if (body.planType !== undefined) {
      const planType = normalizePlanType(body.planType);
      if (planType) $set.planType = planType;
      else $unset.planType = 1;
    }

    if (body.subscriptionStatus !== undefined) {
      const subscriptionStatus = normalizeSubscriptionStatus(body.subscriptionStatus);
      if (subscriptionStatus) $set.subscriptionStatus = subscriptionStatus;
      else $unset.subscriptionStatus = 1;
    }

    if (body.influencerSize !== undefined) {
      const influencerSize = normalizeInfluencerSize(body.influencerSize);
      if (influencerSize) $set.influencerSize = influencerSize;
      else $unset.influencerSize = 1;
    }

    if (body.contentType !== undefined) {
      const contentType = normalizeContentType(body.contentType);
      if (contentType) $set.contentType = contentType;
      else $unset.contentType = 1;
    }

    const { startDate, endDate } = resolveTimelineDates(body);

    if (startDate !== undefined) {
      $set['campaignTimeline.startDate'] = startDate;
    }

    if (endDate !== undefined) {
      $set['campaignTimeline.endDate'] = endDate;
    }

    const updateDoc = {};
    if (Object.keys($set).length) updateDoc.$set = $set;
    if (Object.keys($unset).length) updateDoc.$unset = $unset;

    const doc = await BrandNetwork.findByIdAndUpdate(id, updateDoc, {
      new: true,
      runValidators: true,
    }).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    return res.json({
      success: true,
      data: doc,
    });
  } catch (err) {
    console.error('[updateBrandNetwork] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};