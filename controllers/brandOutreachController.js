'use strict';

const mongoose = require('mongoose');
const {
  BrandOutreach,
  BRAND_SIGNUP_STATUS,
  BRAND_CONVERSION_PLAN,
} = require('../models/brandOutreach');
const { BrandNetwork } = require('../models/brandNetwork');
const {
  getBrandThreadConversationState,
} = require('../services/adminEmail.service');

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

function toNullableDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeBooleanQuery(value) {
  const v = cleanStr(value).toLowerCase();
  if (!v) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function normalizeSignupStatus(value) {
  const v = cleanStr(value).toLowerCase();

  if (['signed up', 'signed_up', 'signup', 'signedup'].includes(v)) {
    return BRAND_SIGNUP_STATUS.SIGNED_UP;
  }

  return BRAND_SIGNUP_STATUS.NOT_SIGNED_UP;
}

function normalizeConversionPlan(value) {
  const v = cleanStr(value).toLowerCase();

  if (['trial', 'trial pack', 'trial_pack', 'trialpack'].includes(v)) {
    return BRAND_CONVERSION_PLAN.TRIAL_PACK;
  }

  if (['subscription', 'subscribed'].includes(v)) {
    return BRAND_CONVERSION_PLAN.SUBSCRIPTION;
  }

  return BRAND_CONVERSION_PLAN.NOT_CONVERTED;
}

async function buildEmailStateForBrandRow(row, actorAdminId) {
  if (!row?.emailOfPerson) {
    return {
      threadId: null,
      outboundCount: 0,
      outreachSentAt: null,
      followUp1SentAt: null,
      followUp2SentAt: null,
      followUp3SentAt: null,
      replyChecked: false,
      repliedAt: null,
      replyText: '',
    };
  }

  try {
    return await getBrandThreadConversationState({
      brandOutreachId: row._id,
      recipientEmail: row.emailOfPerson,
      actorAdminId,
    });
  } catch (error) {
    return {
      threadId: null,
      outboundCount: 0,
      outreachSentAt: null,
      followUp1SentAt: null,
      followUp2SentAt: null,
      followUp3SentAt: null,
      replyChecked: false,
      repliedAt: null,
      replyText: '',
      error: error?.message || 'Failed to derive email state',
    };
  }
}

function buildMoveToNetworkEligibility(row) {
  const signupOk = row?.signupStatus === BRAND_SIGNUP_STATUS.SIGNED_UP;
  const alreadyMoved = !!row?.linkedNetworkId || !!row?.moveToNetwork;

  return {
    canMove: signupOk && !alreadyMoved,
    reasons: [
      !signupOk ? 'Signup status is not Signed Up' : null,
      alreadyMoved ? 'Already moved to network' : null,
    ].filter(Boolean),
  };
}

async function attachEmailStateToBrandRow(row, actorAdminId) {
  const emailState = await buildEmailStateForBrandRow(row, actorAdminId);

  const merged = {
    ...row,
    emailState,

    outreached: Boolean(row.outreached || emailState.outboundCount >= 1),

    dateLastContact:
      emailState.repliedAt ||
      emailState.followUp3SentAt ||
      emailState.followUp2SentAt ||
      emailState.followUp1SentAt ||
      emailState.outreachSentAt ||
      row.dateLastContact ||
      row.updatedAt ||
      row.createdAt ||
      null,

    followUp1: Boolean(row.followUp1 || emailState.outboundCount >= 2),
    followUp1SentAt: emailState.followUp1SentAt || row.followUp1SentAt || null,

    followUp2: Boolean(row.followUp2 || emailState.outboundCount >= 3),
    followUp2SentAt: emailState.followUp2SentAt || row.followUp2SentAt || null,

    followUp3: Boolean(row.followUp3 || emailState.outboundCount >= 4),
    followUp3SentAt: emailState.followUp3SentAt || row.followUp3SentAt || null,

    reply: Boolean(row.reply || emailState.replyChecked),
    repliedAt: emailState.repliedAt || row.repliedAt || null,
    replyText: emailState.replyText || row.replyText || '',
  };

  return {
    ...merged,
    moveToNetworkEligibility: buildMoveToNetworkEligibility(merged),
  };
}

async function attachEmailStateToBrandRows(rows, actorAdminId) {
  return Promise.all(rows.map((row) => attachEmailStateToBrandRow(row, actorAdminId)));
}

exports.createBrandOutreachRow = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};

    const brandName = cleanStr(body.brandName);
    if (!brandName) {
      return res.status(400).json({ error: 'brandName is required' });
    }

    const saved = await BrandOutreach.create({
      brandName,
      website: cleanStr(body.website),
      roleOfPerson: cleanStr(body.roleOfPerson),
      emailOfPerson: cleanStr(body.emailOfPerson).toLowerCase(),
      personalization: cleanStr(body.personalization),

      outreached: !!body.outreached,
      dateLastContact: toNullableDate(body.dateLastContact) ?? null,

      reply: !!body.reply,
      replyText: cleanStr(body.replyText),
      repliedAt:
        body.repliedAt !== undefined
          ? toNullableDate(body.repliedAt)
          : body.reply
            ? new Date()
            : null,

      followUp1: !!body.followUp1,
      followUp1SentAt: toNullableDate(body.followUp1SentAt) ?? null,

      followUp2: !!body.followUp2,
      followUp2SentAt: toNullableDate(body.followUp2SentAt) ?? null,

      followUp3: !!body.followUp3,
      followUp3SentAt: toNullableDate(body.followUp3SentAt) ?? null,

      notes: cleanStr(body.notes),
      signupStatus: normalizeSignupStatus(body.signupStatus),
      conversionToPlan: normalizeConversionPlan(body.conversionToPlan),

      moveToNetwork: false,
      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    const data = await attachEmailStateToBrandRow(saved.toObject(), actorId);

    return res.json({
      success: true,
      message: 'Brand outreach row created successfully',
      data,
    });
  } catch (err) {
    console.error('[createBrandOutreachRow] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.listBrandOutreach = async (req, res) => {
  try {
    const actorId = getActorAdminId(req.admin);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { archivedAt: null };

    const q = cleanStr(req.query.q);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { brandName: rx },
        { website: rx },
        { roleOfPerson: rx },
        { emailOfPerson: rx },
        { personalization: rx },
        { notes: rx },
      ];
    }

    if (cleanStr(req.query.signupStatus)) {
      filter.signupStatus = normalizeSignupStatus(req.query.signupStatus);
    }

    if (cleanStr(req.query.conversionToPlan)) {
      filter.conversionToPlan = normalizeConversionPlan(req.query.conversionToPlan);
    }

    const outreached = normalizeBooleanQuery(req.query.outreached);
    if (outreached !== undefined) {
      filter.outreached = outreached;
    }

    const reply = normalizeBooleanQuery(req.query.reply);
    if (reply !== undefined) {
      filter.reply = reply;
    }

    const moveToNetwork = normalizeBooleanQuery(req.query.moveToNetwork);
    if (moveToNetwork !== undefined) {
      filter.moveToNetwork = moveToNetwork;
    }

    const [total, rows] = await Promise.all([
      BrandOutreach.countDocuments(filter),
      BrandOutreach.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const results = await attachEmailStateToBrandRows(rows, actorId);

    return res.json({
      success: true,
      page,
      limit,
      total,
      hasNext: page * limit < total,
      results,
    });
  } catch (err) {
    console.error('[listBrandOutreach] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getBrandOutreachById = async (req, res) => {
  try {
    const actorId = getActorAdminId(req.admin);
    const id = cleanStr(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const doc = await BrandOutreach.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToBrandRow(doc, actorId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[getBrandOutreachById] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateBrandOutreach = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const body = req.body || {};
    const id = cleanStr(body.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const update = cleanObject({
      brandName: body.brandName !== undefined ? cleanStr(body.brandName) : undefined,
      website: body.website !== undefined ? cleanStr(body.website) : undefined,
      roleOfPerson: body.roleOfPerson !== undefined ? cleanStr(body.roleOfPerson) : undefined,
      emailOfPerson:
        body.emailOfPerson !== undefined
          ? cleanStr(body.emailOfPerson).toLowerCase()
          : undefined,
      personalization:
        body.personalization !== undefined ? cleanStr(body.personalization) : undefined,

      outreached: typeof body.outreached === 'boolean' ? body.outreached : undefined,
      dateLastContact:
        body.dateLastContact !== undefined ? toNullableDate(body.dateLastContact) : undefined,

      reply: typeof body.reply === 'boolean' ? body.reply : undefined,
      replyText: body.replyText !== undefined ? cleanStr(body.replyText) : undefined,
      repliedAt: body.repliedAt !== undefined ? toNullableDate(body.repliedAt) : undefined,

      followUp1: typeof body.followUp1 === 'boolean' ? body.followUp1 : undefined,
      followUp1SentAt:
        body.followUp1SentAt !== undefined ? toNullableDate(body.followUp1SentAt) : undefined,

      followUp2: typeof body.followUp2 === 'boolean' ? body.followUp2 : undefined,
      followUp2SentAt:
        body.followUp2SentAt !== undefined ? toNullableDate(body.followUp2SentAt) : undefined,

      followUp3: typeof body.followUp3 === 'boolean' ? body.followUp3 : undefined,
      followUp3SentAt:
        body.followUp3SentAt !== undefined ? toNullableDate(body.followUp3SentAt) : undefined,

      notes: body.notes !== undefined ? cleanStr(body.notes) : undefined,
      signupStatus:
        body.signupStatus !== undefined ? normalizeSignupStatus(body.signupStatus) : undefined,
      conversionToPlan:
        body.conversionToPlan !== undefined
          ? normalizeConversionPlan(body.conversionToPlan)
          : undefined,

      updatedByAdmin: actorId || null,
    });

    const doc = await BrandOutreach.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToBrandRow(doc, actorId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[updateBrandOutreach] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.markOutreachSent = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const now = new Date();

    const doc = await BrandOutreach.findByIdAndUpdate(
      id,
      {
        $set: {
          outreached: true,
          dateLastContact: now,
          updatedByAdmin: actorId || null,
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToBrandRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[markOutreachSent] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.markFollowUp = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);
    const step = Number(req.body?.step);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    if (![1, 2, 3].includes(step)) {
      return res.status(400).json({ error: 'step must be 1, 2, or 3' });
    }

    const now = new Date();
    const update = {
      [`followUp${step}`]: true,
      [`followUp${step}SentAt`]: now,
      dateLastContact: now,
      updatedByAdmin: actorId || null,
    };

    const doc = await BrandOutreach.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToBrandRow(doc, actorId);

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[markFollowUp] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.markReplyReceived = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const now = new Date();

    const doc = await BrandOutreach.findByIdAndUpdate(
      id,
      {
        $set: {
          reply: true,
          replyText: cleanStr(req.body?.replyText),
          repliedAt: req.body?.repliedAt ? new Date(req.body.repliedAt) : now,
          dateLastContact: now,
          updatedByAdmin: actorId || null,
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const data = await attachEmailStateToBrandRow(doc, actorId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[markReplyReceived] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.moveToNetwork = async (req, res) => {
  try {
    const actor = req.admin;
    const actorId = getActorAdminId(actor);
    const id = cleanStr(req.body?.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Valid outreach id is required' });
    }

    const row = await BrandOutreach.findById(id).lean();
    if (!row) {
      return res.status(404).json({ error: 'Brand outreach row not found' });
    }

    const hydrated = await attachEmailStateToBrandRow(row, actorId);
    const eligibility = hydrated.moveToNetworkEligibility;

    if (!eligibility.canMove) {
      return res.status(400).json({
        success: false,
        error: 'This brand cannot be moved to network yet',
        reasons: eligibility.reasons,
      });
    }

    if (row.linkedNetworkId || row.moveToNetwork) {
      return res.json({
        success: true,
        message: 'Brand already moved to network',
        linkedNetworkId: row.linkedNetworkId || null,
      });
    }

    const contacts = uniqStrings([
      cleanStr(row.roleOfPerson),
      cleanStr(row.emailOfPerson),
    ]).join(' | ');

    const networkPayload = {
      sourceOutreachId: row._id,
      brandName: cleanStr(row.brandName),
      website: cleanStr(row.website),
      contacts,
      notes: cleanStr(row.notes),
      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    };

    if (
      row.conversionToPlan === BRAND_CONVERSION_PLAN.TRIAL_PACK ||
      row.conversionToPlan === BRAND_CONVERSION_PLAN.SUBSCRIPTION
    ) {
      networkPayload.planType = row.conversionToPlan;
    }

    const network = await BrandNetwork.create(networkPayload);

    const updated = await BrandOutreach.findByIdAndUpdate(
      row._id,
      {
        $set: {
          moveToNetwork: true,
          movedToNetworkAt: new Date(),
          linkedNetworkId: network._id,
          updatedByAdmin: actorId || null,
        },
      },
      { new: true }
    ).lean();

    const outreach = await attachEmailStateToBrandRow(updated, actorId);

    return res.json({
      success: true,
      message: 'Brand moved to network successfully',
      outreach,
      network,
    });
  } catch (err) {
    console.error('[moveToNetwork] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};