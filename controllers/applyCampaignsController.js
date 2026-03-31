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
    return req.app?.get?.(key) || (() => { });
  } catch {
    return () => { };
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
            name: inf.name || '',
            isShortlisted: 0,
            isUndicided: 0,
            isRejected: 0,
            appliedAt: new Date()
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
/**
 * POST /ApplyCampaigns/list
 * Body: {
 *   campaignId,
 *   page,
 *   limit,
 *   search,
 *   sortField,
 *   createdPage,
 *   sortOrder,
 *   isShortlisted, // optional: 1
 *   isUndicided,   // optional: 1
 *   isRejected     // optional: 1
 * }
 */


exports.getListByCampaign = async (req, res) => {
  const {
    campaignId,
    page = 1,
    limit = 10,
    search,

    // generic sorting
    sortField,
    sortOrder = 0,

    // preset sorting from UI dropdown
    sortBy, // priority | recentlyAdded | highestEngagement | highestFollower | priceLowToHigh | priceHighToLow

    createdPage,

    // tabs / status filters
    filterStatus,   // all | applied | shortlisted | undecided | rejected | active | invited | completed
    filter,
    influencerType,

    // modash filters
    engagementRate, // "0-2%" | "2-5%" | "5-8%" | "8-12%" | "12%+" | array
    influencerTier, // "Nano" | "Micro" | "Mid-tier" | "Macro" | "Mega" | array
    platform,       // "Instagram" | "Youtube" | "TikTok" | array

    // category filter from InfluencerModel.categories[].categoryId
    categoryId,     // single category id
    categoryIds,    // array of category ids
    category,       // fallback alias if frontend sends category

    // date filter from ApplyCampaign only
    date,           // "today" | "last7days" | "last30days"
    dateFilter      // fallback alias or { from, to }
  } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    const normalizeText = (value) => String(value ?? '').trim().toLowerCase();
    const normalizeStatus = (value) => String(value ?? '').trim().toUpperCase();
    const normalizeRole = (value) => String(value ?? '').trim().toLowerCase();

    const toArray = (value) => {
      if (value == null || value === '') return [];
      if (Array.isArray(value)) {
        return value.map((v) => String(v ?? '').trim()).filter(Boolean);
      }
      return String(value)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    };

    const getNested = (obj, path) => {
      try {
        return path
          .split('.')
          .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
      } catch {
        return undefined;
      }
    };

    const toNumber = (value) => {
      if (value == null) return null;
      if (typeof value === 'number' && Number.isFinite(value)) return value;

      const cleaned = String(value).replace(/[%,$\s,]/g, '');
      const num = Number(cleaned);
      return Number.isFinite(num) ? num : null;
    };

    const getFirstNumber = (obj, paths = []) => {
      for (const path of paths) {
        const value = getNested(obj, path);
        const num = toNumber(value);
        if (num != null) return num;
      }
      return null;
    };

    const getFirstText = (obj, paths = []) => {
      for (const path of paths) {
        const value = getNested(obj, path);
        if (value != null && String(value).trim()) {
          return String(value).trim();
        }
      }
      return null;
    };

    const serializeModashProfile = (profile) => {
      if (!profile) return null;
      return {
        ...profile,
        _id: profile._id ? String(profile._id) : null,
        influencerId: profile.influencerId ? String(profile.influencerId) : null
      };
    };

    const getFollowersFromProfile = (profile) => {
      return (
        getFirstNumber(profile, [
          'followers',
          'followerCount',
          'followersCount',
          'audienceSize',
          'audience_size',
          'stats.followers',
          'metrics.followers',
          'profile.followers'
        ]) || 0
      );
    };

    const getEngagementRateFromProfile = (profile) => {
      let value = getFirstNumber(profile, [
        'engagementRate',
        'engagement_rate',
        'avgEngagementRate',
        'avg_engagement_rate',
        'er',
        'stats.engagementRate',
        'metrics.engagementRate',
        'engagement.rate'
      ]);

      if (value == null) return null;

      // if stored as decimal like 0.045 => 4.5%
      if (value > 0 && value <= 1) {
        value = value * 100;
      }

      return Number(value.toFixed(2));
    };

    const getPlatformFromProfile = (profile) => {
      return getFirstText(profile, [
        'provider',
        'platform',
        'channel',
        'source',
        'network'
      ]);
    };

    const resolveTierFromFollowers = (followers) => {
      const n = Number(followers) || 0;

      if (n >= 1000 && n <= 10000) return 'nano';
      if (n > 10000 && n <= 50000) return 'micro';
      if (n > 50000 && n <= 250000) return 'mid-tier';
      if (n > 250000 && n <= 1000000) return 'macro';
      if (n > 1000000) return 'mega';
      return null;
    };

    const normalizeTierToken = (value) => {
      const token = normalizeText(value);
      if (token.includes('nano')) return 'nano';
      if (token.includes('micro')) return 'micro';
      if (token.includes('mid')) return 'mid-tier';
      if (token.includes('macro')) return 'macro';
      if (token.includes('mega')) return 'mega';
      return token;
    };

    const matchesTier = (followers, selectedTiers) => {
      if (!selectedTiers.length) return true;
      const tier = resolveTierFromFollowers(followers);
      if (!tier) return false;
      return selectedTiers.map(normalizeTierToken).includes(tier);
    };

    const normalizeEngagementBucket = (value) =>
      normalizeText(value).replace(/\s+/g, '').replace('–', '-').replace('—', '-');

    const matchesEngagementRate = (rate, selectedBuckets) => {
      if (!selectedBuckets.length) return true;
      if (rate == null) return false;

      const buckets = selectedBuckets.map(normalizeEngagementBucket);

      return buckets.some((bucket) => {
        if (bucket === 'all') return true;
        if (bucket === '0-2%') return rate >= 0 && rate <= 2;
        if (bucket === '2-5%') return rate > 2 && rate <= 5;
        if (bucket === '5-8%') return rate > 5 && rate <= 8;
        if (bucket === '8-12%') return rate > 8 && rate <= 12;
        if (bucket === '12%+' || bucket === '12+') return rate > 12;
        return false;
      });
    };

    const matchesPlatform = (value, selectedPlatforms) => {
      if (!selectedPlatforms.length) return true;
      return selectedPlatforms.map(normalizeText).includes(normalizeText(value));
    };

    // CATEGORY FILTER ONLY FROM InfluencerModel.categories ARRAY
    const matchesCategoryIds = (rowCategoryIds, selectedCategoryIds) => {
      if (!selectedCategoryIds.length) return true;
      const current = (rowCategoryIds || []).map(String);
      return selectedCategoryIds.some((id) => current.includes(String(id)));
    };

    const resolveApplicantDate = (applicant, recordCreatedAt) => {
      return applicant?.appliedAt || applicant?.updatedAt || recordCreatedAt || null;
    };

    const resolveApplicantFallbackStatus = (applicant) => {
      if (Number(applicant?.isShortlisted) === 1) return 'shortlisted';
      if (Number(applicant?.isUndicided) === 1) return 'not confirm';
      if (Number(applicant?.isRejected) === 1) return 'rejected';
      return '';
    };

    const resolveApplicantStatuses = (applicant) => {
      const fallback = resolveApplicantFallbackStatus(applicant);
      const statusBrand = String(applicant?.statusBrand || '').trim() || fallback;
      const statusInfluencer = String(applicant?.statusInfluencer || '').trim() || fallback;

      return {
        statusBrand,
        statusInfluencer
      };
    };

    const matchesDateFilter = (rowDate, rawDateFilter) => {
      if (!rawDateFilter || rawDateFilter === 'all') return true;
      if (!rowDate) return false;

      const valueDate = new Date(rowDate);
      if (Number.isNaN(valueDate.getTime())) return false;

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      if (typeof rawDateFilter === 'object' && rawDateFilter !== null) {
        const from = rawDateFilter.from ? new Date(rawDateFilter.from) : null;
        const to = rawDateFilter.to ? new Date(rawDateFilter.to) : null;

        if (from && !Number.isNaN(from.getTime()) && valueDate < from) return false;
        if (to && !Number.isNaN(to.getTime())) {
          const end = new Date(to);
          end.setHours(23, 59, 59, 999);
          if (valueDate > end) return false;
        }
        return true;
      }

      const token = normalizeText(rawDateFilter).replace(/\s+/g, '');

      if (token === 'today') {
        return valueDate >= todayStart;
      }

      if (token === 'last7days' || token === '7days') {
        const start = new Date(todayStart);
        start.setDate(start.getDate() - 6);
        return valueDate >= start;
      }

      if (token === 'last30days' || token === '30days') {
        const start = new Date(todayStart);
        start.setDate(start.getDate() - 29);
        return valueDate >= start;
      }

      return true;
    };

    const resolveLifecycleFlags = (contract) => {
      if (!contract) {
        return {
          lifecycleStatus: null,
          lifecycleStatusRaw: null,
          isFinalUpdate: false,
          isInvited: 0,
          isActive: 0,
          isCompleted: 0
        };
      }

      const rawLifecycleStatus =
        contract.status ||
        contract.contractStatus ||
        contract.lifecycleStatus ||
        contract.currentStatus;

      const lifecycleStatus = normalizeText(rawLifecycleStatus);
      const lifecycleStatusRaw = normalizeStatus(rawLifecycleStatus);

      const isRejectedContract = Number(contract?.isRejected) === 1;

      const isFinalUpdate =
        contract?.isFinalUpdate === true ||
        String(contract?.isFinalUpdate).toLowerCase() === 'true' ||
        Number(contract?.isFinalUpdate) === 1;

      const isCompleted =
        lifecycleStatus === 'completed' || lifecycleStatus === 'complete' ? 1 : 0;

      // ACTIVE ONLY FOR THESE TWO RAW STATUSES
      const isActive =
        !isRejectedContract &&
        isCompleted === 0 &&
        (
          lifecycleStatusRaw === 'INFLUENCER_ACCEPTED' ||
          lifecycleStatusRaw === 'READY_TO_SIGN'
        )
          ? 1
          : 0;

      // keep invited separate from active
      const isInvited =
        !isRejectedContract &&
        isCompleted === 0 &&
        isActive === 0 &&
        (
          lifecycleStatus === 'invited' ||
          lifecycleStatus === 'invite_sent' ||
          lifecycleStatus === 'pending'
        )
          ? 1
          : 0;

      return {
        lifecycleStatus,
        lifecycleStatusRaw,
        isFinalUpdate,
        isInvited,
        isActive,
        isCompleted
      };
    };

    const getFinalStatus = (row) => {
      if (row.isCompleted === 1) return 'completed';
      if (row.isActive === 1) return 'active';
      if (row.isInvited === 1) return 'invited';
      if (row.isRejected === 1) return 'rejected';
      if (row.isShortlisted === 1) return 'shortlisted';
      if (row.isUndicided === 1) return 'undecided';
      return 'applied';
    };

    const matchesInfluencerType = (row, rawType) => {
      const type = normalizeText(rawType);

      if (!type || type === 'all' || type === 'all influencer') {
        return true;
      }

      if (type === 'undicided') {
        return row.finalStatus === 'undecided';
      }

      return row.finalStatus === type;
    };

    const getPriorityRank = (status) => {
      switch (status) {
        case 'shortlisted':
          return 1;
        case 'active':
          return 2;
        case 'invited':
          return 3;
        case 'undecided':
          return 4;
        case 'rejected':
          return 5;
        case 'completed':
          return 6;
        case 'applied':
        default:
          return 7;
      }
    };

    const sortRows = (rows, presetSort, rawSortField, rawSortOrder) => {
      const list = [...rows];
      const dir = Number(rawSortOrder) === 1 ? -1 : 1;

      const compareText = (a, b) =>
        String(a ?? '').localeCompare(String(b ?? ''));

      const compareDate = (a, b) => {
        const ta = a ? new Date(a).getTime() : 0;
        const tb = b ? new Date(b).getTime() : 0;
        return ta - tb;
      };

      const compareNum = (a, b) => Number(a || 0) - Number(b || 0);

      if (presetSort) {
        const key = normalizeText(presetSort);

        if (key === 'priority') {
          list.sort((a, b) => {
            const r = getPriorityRank(a.finalStatus) - getPriorityRank(b.finalStatus);
            if (r !== 0) return r;
            return compareDate(b.appliedAt, a.appliedAt);
          });

          return list;
        }

        if (key === 'recentlyadded' || key === 'recently added') {
          list.sort((a, b) => compareDate(b.appliedAt, a.appliedAt));
          return list;
        }

        if (key === 'highestengagement' || key === 'highest engagement') {
          list.sort((a, b) => compareNum(b.engagementRate, a.engagementRate));
          return list;
        }

        if (key === 'highestfollower' || key === 'highest follower') {
          list.sort((a, b) => compareNum(b.audienceSize, a.audienceSize));
          return list;
        }

        if (
          key === 'pricelowtohigh' ||
          key === 'price low to high' ||
          key === 'price: low to high'
        ) {
          list.sort((a, b) => compareNum(a.feeAmount, b.feeAmount));
          return list;
        }

        if (
          key === 'pricehightolow' ||
          key === 'price high to low' ||
          key === 'price: high to low'
        ) {
          list.sort((a, b) => compareNum(b.feeAmount, a.feeAmount));
          return list;
        }
      }

      if (rawSortField) {
        const aliasMap = {
          profile: 'name',
          followers: 'audienceSize',
          follower: 'audienceSize',
          engagement: 'engagementRate',
          date: 'appliedAt',
          applieddate: 'appliedAt',
          appliedAt: 'appliedAt',
          createdAt: 'appliedAt',
          price: 'feeAmount',
          brandstatus: 'statusBrand',
          influencerstatus: 'statusInfluencer',
          status: 'finalStatus'
        };

        const requested = String(rawSortField).replace(/\s+/g, '');
        const actualField = aliasMap[requested] || rawSortField;

        const allowed = new Set([
          'name',
          'category',
          'audienceSize',
          'engagementRate',
          'appliedAt',
          'primaryPlatform',
          'platform',
          'handle',
          'feeAmount',
          'isShortlisted',
          'isUndicided',
          'isRejected',
          'statusBrand',
          'statusInfluencer',
          'brandStatus',
          'influencerStatus',
          'finalStatus'
        ]);

        if (allowed.has(actualField)) {
          list.sort((a, b) => {
            if (actualField === 'appliedAt') {
              return dir * compareDate(a[actualField], b[actualField]);
            }

            if (actualField === 'finalStatus') {
              return dir * (getPriorityRank(a.finalStatus) - getPriorityRank(b.finalStatus));
            }

            if (
              ['audienceSize', 'engagementRate', 'feeAmount', 'isShortlisted', 'isUndicided', 'isRejected']
                .includes(actualField)
            ) {
              return dir * compareNum(a[actualField], b[actualField]);
            }

            return dir * compareText(a[actualField], b[actualField]);
          });
        }
      }

      return list;
    };

    const record = await ApplyCampaign.findOne({
      campaignId: String(campaignId)
    }).lean();

    if (!record) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: 0,
        statusCounts: {
          total: 0,
          applied: 0,
          active: 0,
          shortlisted: 0,
          undecided: 0,
          rejected: 0,
          invited: 0,
          completed: 0
        },
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const applicants = Array.isArray(record.applicants) ? record.applicants : [];

    const applicantByInf = new Map();
    for (const applicant of applicants) {
      if (!applicant?.influencerId) continue;
      applicantByInf.set(String(applicant.influencerId), applicant);
    }

    const influencerIds = [
      ...new Set(
        applicants
          .map((a) => a?.influencerId)
          .filter((id) => id && mongoose.isValidObjectId(id))
          .map(String)
      )
    ];

    if (!influencerIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: 0,
        statusCounts: {
          total: 0,
          applied: 0,
          active: 0,
          shortlisted: 0,
          undecided: 0,
          rejected: 0,
          invited: 0,
          completed: 0
        },
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const influencersRaw = await InfluencerModel.find({
      _id: { $in: influencerIds.map((id) => new mongoose.Types.ObjectId(id)) }
    }).lean();

    if (!influencersRaw.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        applicantCount: 0,
        statusCounts: {
          total: 0,
          applied: 0,
          active: 0,
          shortlisted: 0,
          undecided: 0,
          rejected: 0,
          invited: 0,
          completed: 0
        },
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const modashProfiles = await Modash.find({
      influencerId: { $in: influencerIds }
    }).lean();

    const modashByInf = new Map();
    for (const profile of modashProfiles) {
      if (!profile?.influencerId) continue;
      const key = String(profile.influencerId);
      if (!modashByInf.has(key)) modashByInf.set(key, []);
      modashByInf.get(key).push(profile);
    }

    const contracts = await Contract.find({
      campaignId: String(campaignId)
    }).lean();

    const isContractedCampaign = contracts.length > 0 ? 1 : 0;

    const contractByInf = new Map(
      contracts
        .filter((c) => c?.influencerId)
        .map((c) => [String(c.influencerId), c])
    );

    const approvedIds = new Set(
      (record.approved || [])
        .map((a) => a?.influencerId)
        .filter(Boolean)
        .map(String)
    );

    const recordCreatedAt =
      record.createdAt || record._id?.getTimestamp?.() || null;

    const selectedStatus = filterStatus || influencerType || filter || '';
    const selectedEngagementRates = toArray(engagementRate).filter(
      (v) => normalizeText(v) !== 'all'
    );
    const selectedTiers = toArray(influencerTier).filter(
      (v) => normalizeText(v) !== 'all'
    );
    const selectedPlatforms = toArray(platform).filter(
      (v) => normalizeText(v) !== 'all'
    );
    const selectedCategoryIds = [
      ...toArray(categoryIds),
      ...toArray(categoryId),
      ...toArray(category)
    ]
      .map(String)
      .filter((v, i, arr) => v && arr.indexOf(v) === i);

    const selectedDateFilter = dateFilter || date || null;

    const rows = influencersRaw.map((inf) => {
      const infIdStr = String(inf._id);
      const applicant = applicantByInf.get(infIdStr) || null;

      const rawProfiles = modashByInf.get(infIdStr) || [];
      const chosenRaw = pickModashProfile(rawProfiles);
      const chosen = serializeModashProfile(chosenRaw);
      const allProfiles = rawProfiles.map(serializeModashProfile);

      const followersFromChosen = getFollowersFromProfile(chosenRaw);
      const audienceSize =
        followersFromChosen ||
        rawProfiles.reduce((sum, p) => sum + (getFollowersFromProfile(p) || 0), 0);

      const engagementRateValue = getEngagementRateFromProfile(chosenRaw);
      const primaryPlatform = getPlatformFromProfile(chosenRaw) || null;

      let handle = null;
      if (chosenRaw) {
        handle =
          (chosenRaw.handle || chosenRaw.username || chosenRaw.fullname || '').trim() || null;
      }
      if (handle && !handle.startsWith('@')) {
        handle = '@' + handle;
      }

      const influencerCategories = Array.isArray(inf?.categories) ? inf.categories : [];
      const influencerCategoryIds = influencerCategories
        .map((c) => c?.categoryId || c?._id || c?.id)
        .filter(Boolean)
        .map(String);

      const categoryName =
        influencerCategories.find((c) => c?.name)?.name || null;

      const contract = contractByInf.get(infIdStr);
      const lifecycle = resolveLifecycleFlags(contract);

      const isShortlisted = Number(applicant?.isShortlisted) === 1 ? 1 : 0;
      const isUndicided = Number(applicant?.isUndicided) === 1 ? 1 : 0;
      const isRejected = Number(applicant?.isRejected) === 1 ? 1 : 0;
      const applicantStatuses = resolveApplicantStatuses(applicant);

      const appliedAt = resolveApplicantDate(applicant, recordCreatedAt);

      const isAssigned = approvedIds.has(infIdStr) ? 1 : 0;
      const isContracted = contract ? 1 : 0;
      const isAccepted = contract?.isAccepted === 1 ? 1 : 0;
      const isContractRejected = contract?.isRejected === 1 ? 1 : 0;

      const baseRow = {
        influencerId: infIdStr,
        name: inf.name || '',
        primaryPlatform,
        platform: primaryPlatform,
        handle,

        // influencer table categories
        category: categoryName,
        categoryIds: influencerCategoryIds,

        audienceSize,
        engagementRate: engagementRateValue,
        influencerTierResolved: resolveTierFromFollowers(audienceSize),

        createdAt: appliedAt,
        appliedAt,

        // raw applicant flags
        isShortlisted,
        isUndicided,
        isUndecided: isUndicided,
        isRejected,

        // applicant status fields from ApplyCampaign.applicants[]
        statusBrand: applicantStatuses.statusBrand,
        statusInfluencer: applicantStatuses.statusInfluencer,
        brandStatus: applicantStatuses.statusBrand,
        influencerStatus: applicantStatuses.statusInfluencer,

        // lifecycle flags from contract
        isInvited: lifecycle.isInvited,
        isActive: lifecycle.isActive,
        isCompleted: lifecycle.isCompleted,
        lifecycleStatus: lifecycle.lifecycleStatus,
        lifecycleStatusRaw: lifecycle.lifecycleStatusRaw,
        isFinalUpdate: lifecycle.isFinalUpdate,

        modashProfile: chosen,
        modashProfiles: allProfiles,

        isAssigned,
        isContracted,
        contractId: contract?._id || null,
        feeAmount: contract?.feeAmount || 0,
        isAccepted,
        isContractRejected,
        rejectedReason: isContractRejected ? contract?.rejectedReason || '' : ''
      };

      const finalStatus = getFinalStatus(baseRow);

      return {
        ...baseRow,
        finalStatus,
        status: finalStatus,
        statusLabel:
          finalStatus === 'undecided'
            ? 'Undecided'
            : finalStatus.charAt(0).toUpperCase() + finalStatus.slice(1)
      };
    });

    const statusCounts = rows.reduce(
      (acc, row) => {
        acc.total += 1;
        if (row.finalStatus === 'applied') acc.applied += 1;
        if (row.finalStatus === 'active') acc.active += 1;
        if (row.finalStatus === 'shortlisted') acc.shortlisted += 1;
        if (row.finalStatus === 'undecided') acc.undecided += 1;
        if (row.finalStatus === 'rejected') acc.rejected += 1;
        if (row.finalStatus === 'invited') acc.invited += 1;
        if (row.finalStatus === 'completed') acc.completed += 1;
        return acc;
      },
      {
        total: 0,
        applied: 0,
        active: 0,
        shortlisted: 0,
        undecided: 0,
        rejected: 0,
        invited: 0,
        completed: 0
      }
    );

    let filtered = rows;

    // optional createdPage logic from your current code
    if (createdPage === true || createdPage === 'true') {
      filtered = filtered.filter((row) => {
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

    // search on row data
    if (search?.trim()) {
      const q = normalizeText(search);
      filtered = filtered.filter((row) => {
        return (
          normalizeText(row.name).includes(q) ||
          normalizeText(row.handle).includes(q) ||
          normalizeText(row.primaryPlatform).includes(q) ||
          normalizeText(row.category).includes(q) ||
          normalizeText(row.statusBrand).includes(q) ||
          normalizeText(row.statusInfluencer).includes(q) ||
          normalizeText(row.finalStatus).includes(q)
        );
      });
    }

    // 1) tab/status filter
    filtered = filtered.filter((row) => matchesInfluencerType(row, selectedStatus));

    // 2) modash filters
    filtered = filtered.filter((row) => {
      if (!matchesEngagementRate(row.engagementRate, selectedEngagementRates)) return false;
      if (!matchesTier(row.audienceSize, selectedTiers)) return false;
      if (!matchesPlatform(row.primaryPlatform, selectedPlatforms)) return false;
      return true;
    });

    // 3) categoryId filter from Influencer.categories[]
    filtered = filtered.filter((row) =>
      matchesCategoryIds(row.categoryIds, selectedCategoryIds)
    );

    // 4) date filter only from ApplyCampaign
    filtered = filtered.filter((row) =>
      matchesDateFilter(row.appliedAt, selectedDateFilter)
    );

    filtered = sortRows(filtered, sortBy, sortField, sortOrder);

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
      applicantCount: statusCounts.total,
      statusCounts,
      appliedFilters: {
        status: selectedStatus || null,
        engagementRate: selectedEngagementRates,
        influencerTier: selectedTiers,
        platform: selectedPlatforms,
        categoryIds: selectedCategoryIds,
        date: selectedDateFilter || null,
        sortBy: sortBy || null,
        sortField: sortField || null,
        sortOrder
      },
      isContracted: isContractedCampaign,
      contractId: contracts[0]?._id || null,
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

/**
 * POST /ApplyCampaigns/set-decision-status
 * Body: {
 *   campaignId,
 *   influencerId,
 *   field // "isShortlisted" | "isUndicided" | "isRejected"
 * }
 */
exports.setApplicantDecisionStatus = async (req, res) => {
  const { campaignId, influencerId, field } = req.body || {};

  if (!campaignId || !influencerId || !field) {
    return res.status(400).json({
      message: 'campaignId, influencerId and field are required'
    });
  }

  if (!isValidObjectId(campaignId) || !isValidObjectId(influencerId)) {
    return res.status(400).json({
      message: 'Invalid campaignId or influencerId'
    });
  }

  if (!['isShortlisted', 'isUndicided', 'isRejected'].includes(field)) {
    return res.status(400).json({
      message: 'field must be one of: isShortlisted, isUndicided, isRejected'
    });
  }

  try {
    const updated = await ApplyCampaign.findOneAndUpdate(
      {
        campaignId: String(campaignId),
        'applicants.influencerId': String(influencerId)
      },
      {
        $set: {
          'applicants.$.isShortlisted': field === 'isShortlisted' ? 1 : 0,
          'applicants.$.isUndicided': field === 'isUndicided' ? 1 : 0,
          'applicants.$.isRejected': field === 'isRejected' ? 1 : 0
        }
      },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        message: 'Application record not found for this influencer in this campaign'
      });
    }

    const applicant = updated.applicants.find(
      (a) => String(a.influencerId) === String(influencerId)
    );

    return res.status(200).json({
      message: 'Applicant status updated successfully',
      applicant
    });
  } catch (err) {
    console.error('Error in setApplicantDecisionStatus:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};