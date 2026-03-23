const mongoose = require('mongoose');
const ApplyCampaign = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
const { InfluencerModel } = require('../models/influencer');
const Contract = require('../models/contract');
const { createAndEmit } = require('../utils/notifier');
const Modash = require('../models/modash');
const Brand = require('../models/brand');
const { sendMail } = require('../utils/mailer');

const ACTIVE_CONTRACT_STATUSES = [
  'draft',
  'sent',
  'viewed',
  'negotiation',
  'finalize',
  'signing',
  'locked',
  'rejected'
];

const FEATURE_KEYS = {
  APPLY_PER_MONTH: 'campaign_applications_per_month',
  ACTIVE_COLLABS: 'active_collaborations'
};

function getEmitter(req, key) {
  try {
    return req.app?.get?.(key) || (() => {});
  } catch {
    return () => {};
  }
}

function getFeature(infDoc, key) {
  return (infDoc?.subscription?.features || []).find((f) => f.key === key) || null;
}

function readLimit(feature) {
  if (!feature) return 0;

  const raw = feature.limit ?? feature.value ?? 0;

  if (raw && typeof raw === 'object') {
    if (raw.unlimited === true) return 0;
    if (Number.isFinite(Number(raw.count))) return Number(raw.count);
    return 0;
  }

  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function ensureMonthlyWindow(influencerId, featureKey, featureObj) {
  const isMonthly =
    /per\s*month/i.test(String(featureObj?.note || '')) ||
    featureObj?.resetsEvery === 'monthly' ||
    /_per_month$/i.test(String(featureKey));

  if (!isMonthly) return featureObj;

  const now = new Date();
  const resetsAt = featureObj?.resetsAt ? new Date(featureObj.resetsAt) : null;

  if (!resetsAt || now > resetsAt) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);

    await InfluencerModel.updateOne(
      { _id: influencerId, 'subscription.features.key': featureKey },
      {
        $set: {
          'subscription.features.$.used': 0,
          'subscription.features.$.resetsAt': next,
          'subscription.features.$.resetsEvery': 'monthly'
        }
      }
    );

    return { ...featureObj, used: 0, resetsAt: next, resetsEvery: 'monthly' };
  }

  const used = Number(featureObj?.used || 0);
  return { ...featureObj, used: Number.isFinite(used) ? used : 0 };
}

async function countActiveCollaborationsForInfluencer(influencerId) {
  return Contract.countDocuments({
    influencerId: String(influencerId),
    isRejected: { $ne: 1 },
    $or: [{ isAssigned: 1 }, { isAccepted: 1 }, { status: { $in: ACTIVE_CONTRACT_STATUSES } }]
  });
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}

function normalizeStatus(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

function normalizeRole(s) {
  return String(s || '').trim().toLowerCase();
}

function pickModashProfile(profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  return (
    profiles
      .slice()
      .sort((a, b) => (Number(b.followers) || 0) - (Number(a.followers) || 0))[0] || null
  );
}

/**
 * POST /apply
 * Body: { campaignId, influencerId }
 */
exports.applyToCampaign = async (req, res) => {
  const { campaignId, influencerId } = req.body || {};

  if (!campaignId || !influencerId) {
    return res.status(400).json({
      message: 'Both campaignId and influencerId are required'
    });
  }

  if (!isValidObjectId(campaignId) || !isValidObjectId(influencerId)) {
    return res.status(400).json({
      message: 'Invalid campaignId or influencerId'
    });
  }

  try {
    const inf = await InfluencerModel.findById(influencerId).lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const camp = await Campaign.findById(
      campaignId,
      '_id brandId brandName productOrServiceName campaignTitle applicantCount hasApplied'
    ).lean();

    if (!camp) {
      return res.status(404).json({ message: 'Campaign not found' });
    }

    // Optional quota check:
    // Only enforced if subscription.features exists on influencer doc.
    let applyFeature = getFeature(inf, FEATURE_KEYS.APPLY_PER_MONTH);
    if (applyFeature) {
      applyFeature = await ensureMonthlyWindow(influencerId, FEATURE_KEYS.APPLY_PER_MONTH, applyFeature);

      const applyLimit = readLimit(applyFeature);
      const usedNow = Number(applyFeature.used || 0);

      if (applyLimit > 0 && usedNow >= applyLimit) {
        return res.status(403).json({
          message: `Application limit reached (${applyLimit}). Please upgrade your plan to apply more.`
        });
      }
    }

    const activeCapFeature = getFeature(inf, FEATURE_KEYS.ACTIVE_COLLABS);
    const activeCap = readLimit(activeCapFeature);
    if (activeCap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= activeCap) {
        return res.status(403).json({
          message: `You’ve reached your active collaborations limit (${activeCap}). Finish/close one or upgrade your plan.`
        });
      }
    }

    const alreadyApplied = await ApplyCampaign.findOne({
      campaignId: String(campaignId),
      'applicants.influencerId': String(influencerId)
    }).lean();

    if (alreadyApplied) {
      return res.status(400).json({
        message: 'You have already applied to this campaign'
      });
    }

    const updatedApply = await ApplyCampaign.findOneAndUpdate(
      { campaignId: String(campaignId) },
      {
        $setOnInsert: { campaignId: String(campaignId) },
        $push: {
          applicants: {
            influencerId: String(influencerId),
            name: inf.name || ''
          }
        }
      },
      {
        new: true,
        upsert: true
      }
    ).lean();

    const applicantCount = updatedApply?.applicants?.length || 0;

    if (applyFeature) {
      await InfluencerModel.updateOne(
        { _id: influencerId },
        { $inc: { 'subscription.features.$[feat].used': 1 } },
        { arrayFilters: [{ 'feat.key': FEATURE_KEYS.APPLY_PER_MONTH }] }
      );
    }

    await Campaign.findByIdAndUpdate(campaignId, {
      $set: {
        applicantCount,
        hasApplied: 1
      }
    });

    let brandEmail = null;
    let brandDisplayName = camp?.brandName || '';

    if (camp?.brandId && isValidObjectId(String(camp.brandId))) {
      const brandDoc = await Brand.findById(camp.brandId, 'email name').lean();
      if (brandDoc) {
        brandEmail = brandDoc.email || null;
        if (!brandDisplayName && brandDoc.name) {
          brandDisplayName = brandDoc.name;
        }
      }
    }

    if (brandEmail) {
      const brandAppBaseUrl = process.env.FRONTEND_ORIGIN || 'https://collabglam.com';
      const subject = `New application for "${camp?.productOrServiceName || camp?.campaignTitle || 'your campaign'}"`;
      const dashboardLink = `${brandAppBaseUrl}/brand/created-campaign/applied-inf?id=${campaignId}`;

      const plainText = `
Hi ${brandDisplayName || 'there'},

${inf.name || 'An influencer'} has just applied to your campaign "${camp?.productOrServiceName || camp?.campaignTitle || 'Campaign'}".

Influencer ID: ${influencerId}
Total applicants so far: ${applicantCount}

You can review the application(s) here:
${dashboardLink}

— CollabGlam
      `.trim();

      const accentFrom = '#FFA135';
      const accentTo = '#FF7236';

      const htmlBody = `
  <div style="background-color:#f5f5f7;padding:24px;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5;">
      <tr>
        <td style="padding:20px 24px 12px 24px;border-bottom:1px solid #f0f0f0;background:#111111;">
          <h1 style="margin:0;font-size:18px;line-height:1.4;color:#ffffff;font-weight:600;">
            New Campaign Application
          </h1>
          <p style="margin:4px 0 0 0;font-size:13px;color:#f5f5f5;">
            An influencer just applied to your campaign on CollabGlam.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:20px 24px 16px 24px;">
          <p style="margin:0 0 12px 0;font-size:14px;color:#333333;">
            Hi ${brandDisplayName || 'there'},
          </p>

          <p style="margin:0 0 16px 0;font-size:14px;color:#333333;line-height:1.6;">
            <strong>${inf.name || 'An influencer'}</strong> has just applied to your campaign
            <strong>"${camp?.productOrServiceName || camp?.campaignTitle || 'Campaign'}"</strong>.
          </p>

          <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 16px 0;">
            <tr>
              <td style="padding:10px 12px;border:1px solid #eeeeee;border-radius:8px;background:#fafafa;">
                <p style="margin:0;font-size:13px;color:#555555;line-height:1.6;">
                  <strong style="display:inline-block;width:130px;">Applicants so far:</strong>
                  <span>${applicantCount}</span>
                </p>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 18px 0;font-size:14px;color:#333333;line-height:1.6;">
            You can review this application and manage all applicants directly from your dashboard.
          </p>

          <table border="0" cellspacing="0" cellpadding="0" style="margin:0 0 8px 0;">
            <tr>
              <td align="center" style="border-radius:999px;overflow:hidden;">
                <a href="${dashboardLink}"
                  style="
                    display:inline-block;
                    padding:10px 22px;
                    font-size:14px;
                    font-weight:600;
                    text-decoration:none;
                    border-radius:999px;
                    background:${accentFrom};
                    background-image:linear-gradient(135deg, ${accentFrom}, ${accentTo});
                    color:#ffffff;
                    border:1px solid ${accentFrom};
                    box-shadow:0 2px 6px rgba(0,0,0,0.12);
                  ">
                  View Applicants
                </a>
              </td>
            </tr>
          </table>

          <p style="margin:10px 0 0 0;font-size:11px;color:#888888;line-height:1.4;">
            If the button doesn’t work, copy and paste this link into your browser:<br/>
            <span style="word-break:break-all;color:#555555;">${dashboardLink}</span>
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:14px 24px 18px 24px;border-top:1px solid #f0f0f0;background:#fafafa;">
          <p style="margin:0;font-size:11px;color:#999999;line-height:1.5;">
            You’re receiving this email because your brand has a campaign on CollabGlam.
          </p>
          <p style="margin:4px 0 0 0;font-size:11px;color:#999999;">
            — CollabGlam Team
          </p>
        </td>
      </tr>
    </table>
  </div>
`;

      try {
        await sendMail({
          to: brandEmail,
          subject,
          text: plainText,
          html: htmlBody
        });
      } catch (e) {
        console.warn('Email to brand failed (applyToCampaign):', e?.message || e);
      }
    }

    if (camp?.brandId) {
      try {
        await createAndEmit({
          recipientType: 'brand',
          brandId: String(camp.brandId),
          type: 'apply.submitted',
          title: `New applicant: ${inf.name || 'Influencer'}`,
          message: `${inf.name || 'An influencer'} applied to "${camp.productOrServiceName || camp.campaignTitle || 'your campaign'}".`,
          entityType: 'apply',
          entityId: String(campaignId),
          actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
          meta: {
            influencerId: String(influencerId),
            influencerName: inf.name || '',
            applicantCount
          }
        });
      } catch (e) {
        console.warn('createAndEmit failed (brand apply.submitted):', e?.message || e);
      }

      const emitToBrand = getEmitter(req, 'emitToBrand');
      try {
        emitToBrand(String(camp.brandId), 'application:new', {
          campaignId: String(campaignId),
          brandId: String(camp.brandId),
          title: camp.productOrServiceName || camp.campaignTitle || '',
          applicant: {
            influencerId: String(influencerId),
            name: inf.name || ''
          },
          applicantCount,
          actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`
        });
      } catch (e) {
        console.warn('emitToBrand failed:', e?.message || e);
      }
    }

    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.submitted.self',
        title: 'Application sent',
        message: `You applied to "${camp?.productOrServiceName || camp?.campaignTitle || 'Campaign'}" by ${camp?.brandName || 'Brand'}.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/dashboard/view-campaign?id=${campaignId}`,
        meta: {
          brandId: camp?.brandId ? String(camp.brandId) : null,
          brandName: camp?.brandName || '',
          productOrServiceName: camp?.productOrServiceName || '',
          campaignTitle: camp?.campaignTitle || ''
        }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.submitted.self):', e?.message || e);
    }

    return res.status(200).json({
      message: 'Application recorded',
      campaignId: String(campaignId),
      influencerId: String(influencerId),
      applicantCount,
      hasApplied: 1
    });
  } catch (err) {
    console.error('Error in applyToCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /ApplyCampaigns/list
 * Body: { campaignId, page, limit, search, sortField, createdPage, sortOrder }
 */
exports.getListByCampaign = async (req, res) => {
  const {
    campaignId,
    page = 1,
    limit = 10,
    search,
    sortField,
    createdPage,
    sortOrder = 0
  } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    const record = await ApplyCampaign.findOne({ campaignId: String(campaignId) }).lean();

    if (!record) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const influencerIds = (record.applicants || [])
      .map((a) => a.influencerId)
      .filter((id) => id && isValidObjectId(id))
      .map(String);

    if (!influencerIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: record.applicants?.length || 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const filter = {
      _id: { $in: influencerIds.map((id) => toObjectId(id)) }
    };

    if (search?.trim()) {
      filter.name = { $regex: search.trim(), $options: 'i' };
    }

    const influencersRaw = await InfluencerModel.find(filter).lean();

    if (!influencersRaw.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: record.applicants?.length || 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const modashProfiles = await Modash.find({
      influencerId: { $in: influencerIds }
    }).lean();

    const modashByInf = new Map();
    for (const p of modashProfiles) {
      if (!p.influencerId) continue;
      const key = String(p.influencerId);
      if (!modashByInf.has(key)) modashByInf.set(key, []);
      modashByInf.get(key).push(p);
    }

    const contracts = await Contract.find({ campaignId: String(campaignId) }).lean();
    const isContractedCampaign = contracts.length > 0 ? 1 : 0;
    const contractByInf = new Map(contracts.map((c) => [String(c.influencerId), c]));
    const approvedId = record.approved?.[0]?.influencerId
      ? String(record.approved[0].influencerId)
      : null;

    const applicationCreatedAt = record.createdAt || record._id?.getTimestamp?.() || null;

    const serializeModashProfile = (profile) => {
      if (!profile) return null;

      return {
        ...profile,
        _id: profile._id ? String(profile._id) : null,
        influencerId: profile.influencerId ? String(profile.influencerId) : null
      };
    };

    const condensed = influencersRaw.map((inf) => {
      const infIdStr = String(inf._id);

      const rawProfiles = modashByInf.get(infIdStr) || [];
      const audienceSize = rawProfiles.reduce(
        (sum, p) => sum + (Number(p?.followers) || 0),
        0
      );

      const chosenRaw = pickModashProfile(rawProfiles);
      const chosen = serializeModashProfile(chosenRaw);
      const allProfiles = rawProfiles.map(serializeModashProfile);

      let handle = null;
      if (chosenRaw) {
        handle =
          (chosenRaw.handle || chosenRaw.username || chosenRaw.fullname || '').trim() || null;
      }
      if (handle && !handle.startsWith('@')) handle = '@' + handle;

      const primaryPlatform = chosenRaw?.provider || null;

      let categoryName = null;
      if (Array.isArray(inf.categories) && inf.categories.length > 0) {
        categoryName = inf.categories[0]?.name || null;
      }

      const c = contractByInf.get(infIdStr);
      const isAssigned = approvedId === infIdStr ? 1 : 0;
      const isContracted = c ? 1 : 0;
      const isAccepted = c?.isAccepted === 1 ? 1 : 0;
      const isRejected = c?.isRejected === 1 ? 1 : 0;

      return {
        influencerId: infIdStr,
        name: inf.name || '',
        primaryPlatform,
        handle,
        category: categoryName,
        audienceSize,
        createdAt: applicationCreatedAt,

        // full modash data
        modashProfile: chosen,        // selected full profile
        modashProfiles: allProfiles,  // all profiles full data

        isAssigned,
        isContracted,
        contractId: c?.contractId || null,
        feeAmount: c?.feeAmount || 0,
        isAccepted,
        isRejected,
        rejectedReason: isRejected ? c?.rejectedReason || '' : ''
      };
    });

    let filtered = condensed;

    if (createdPage === true || createdPage === 'true') {
      filtered = condensed.filter((row) => {
        const c = contractByInf.get(String(row.influencerId));
        if (!c) return true;

        const status = normalizeStatus(c.status || c.contractStatus);
        const awaitingRole = normalizeRole(
          c.awaitingRole || c.awaiting_role || c.awaiting?.role
        );

        if (status === 'READY_TO_SIGN' && awaitingRole === 'collabglam') {
          return false;
        }

        return true;
      });
    }

    const dir = sortOrder === 1 ? -1 : 1;

    if (sortField) {
      const allowed = new Set([
        'name',
        'primaryPlatform',
        'category',
        'audienceSize',
        'handle',
        'createdAt'
      ]);

      if (allowed.has(sortField)) {
        filtered.sort((a, b) => {
          const av = a[sortField];
          const bv = b[sortField];

          if (sortField === 'createdAt') {
            const ta = av ? new Date(av).getTime() : 0;
            const tb = bv ? new Date(bv).getTime() : 0;
            return dir * (ta - tb);
          }

          if (typeof av === 'number' && typeof bv === 'number') {
            return dir * (av - bv);
          }

          return dir * String(av ?? '').localeCompare(String(bv ?? ''));
        });
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const start = (pageNum - 1) * limNum;
    const end = start + limNum;

    const total = filtered.length;
    const paged = filtered.slice(start, end);

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      applicantCount:
        createdPage === true || createdPage === 'true'
          ? total
          : record.applicants?.length || 0,
      isContracted: isContractedCampaign,
      contractId: null,
      influencers: paged
    });
  } catch (err) {
    console.error('Error in getListByCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /ApplyCampaigns/approve
 * Body: { campaignId, influencerId }
 */
exports.approveInfluencer = async (req, res) => {
  const { campaignId, influencerId } = req.body || {};

  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  if (!isValidObjectId(campaignId) || !isValidObjectId(influencerId)) {
    return res.status(400).json({ message: 'Invalid campaignId or influencerId' });
  }

  try {
    const inf = await InfluencerModel.findById(influencerId).lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const activeCapFeature = getFeature(inf, FEATURE_KEYS.ACTIVE_COLLABS);
    const activeCap = readLimit(activeCapFeature);
    if (activeCap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= activeCap) {
        return res.status(403).json({
          message: `Cannot approve — influencer already has ${activeNow}/${activeCap} active collaborations.`
        });
      }
    }

    const record = await ApplyCampaign.findOne({ campaignId: String(campaignId) });
    if (!record) {
      return res.status(404).json({ message: 'No applications found for this campaign' });
    }

    const applicant = (record.applicants || []).find(
      (a) => String(a.influencerId) === String(influencerId)
    );

    if (!applicant) {
      return res.status(400).json({ message: 'Influencer did not apply for this campaign' });
    }

    if (record.approved && record.approved.length > 0) {
      return res.status(400).json({ message: 'An influencer is already approved for this campaign' });
    }

    record.approved = [{ influencerId: String(applicant.influencerId), name: applicant.name || '' }];
    await record.save();

    const camp = await Campaign.findById(
      campaignId,
      '_id productOrServiceName campaignTitle brandName brandId'
    ).lean();

    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.approved',
        title: `Approved for "${camp?.productOrServiceName || camp?.campaignTitle || 'Campaign'}"`,
        message: `Brand ${camp?.brandName || ''} approved your application.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/campaigns/${campaignId}`,
        meta: { brandId: camp?.brandId ? String(camp.brandId) : null }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.approved):', e?.message || e);
    }

    const emitToInfluencer = getEmitter(req, 'emitToInfluencer');
    try {
      emitToInfluencer(String(influencerId), 'application:approved', {
        campaignId: String(campaignId),
        title: camp?.productOrServiceName || camp?.campaignTitle || '',
        brandName: camp?.brandName || '',
        actionPath: `/influencer/campaigns/${campaignId}`
      });
    } catch (e) {
      console.warn('emitToInfluencer failed:', e?.message || e);
    }

    return res.status(200).json({
      message: 'Influencer approved successfully',
      campaignId: String(campaignId),
      approved: record.approved?.[0] || null
    });
  } catch (err) {
    console.error('Error in approveInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};