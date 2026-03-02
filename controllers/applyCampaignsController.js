// controllers/ApplyCampaignsController.js

const ApplyCampaign = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const Category = require('../models/categories');
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

// ✅ Keep feature keys consistent with influencerPlans
const FEATURE_KEYS = {
  APPLY_PER_MONTH: 'campaign_applications_per_month',
  ACTIVE_COLLABS: 'active_collaborations'
};

// Optional socket.io emitters if app has them set
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

async function countActiveCollaborationsForInfluencer(influencerId) {
  return Contract.countDocuments({
    influencerId: String(influencerId),
    isRejected: { $ne: 1 },
    $or: [{ isAssigned: 1 }, { isAccepted: 1 }, { status: { $in: ACTIVE_CONTRACT_STATUSES } }]
  });
}

async function buildSubToParentNameMap() {
  const rows = await Category.find({}, 'name subcategories').lean();
  const map = new Map();
  for (const r of rows) {
    for (const s of r.subcategories || []) {
      map.set(String(s.subcategoryId), r.name);
    }
  }
  return map;
}

/**
 * Normalize plan/feature limits:
 * - number (10)
 * - string ("10")
 * - object ({ unlimited: true })
 */
function readLimit(feature) {
  if (!feature) return 0;

  const raw = feature.limit ?? feature.value ?? 0;

  // Unlimited object
  if (raw && typeof raw === 'object') {
    if (raw.unlimited === true) return 0;
    // optional future format: { count: 10 }
    if (Number.isFinite(Number(raw.count))) return Number(raw.count);
    return 0;
  }

  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Ensures monthly reset window exists for monthly features.
 * Marks feature as monthly if:
 * - feature.note contains "per month", OR
 * - feature.resetsEvery === "monthly", OR
 * - key ends with "_per_month"
 */
async function ensureMonthlyWindow(influencerId, featureKey, featureObj) {
  const isMonthly =
    /per\s*month/i.test(String(featureObj?.note || '')) ||
    featureObj?.resetsEvery === 'monthly' ||
    /_per_month$/i.test(String(featureKey));

  if (!isMonthly) return featureObj;

  const now = new Date();
  const resetsAt = featureObj?.resetsAt ? new Date(featureObj.resetsAt) : null;

  // If never set, or already past, roll a new monthly window and zero usage
  if (!resetsAt || now > resetsAt) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);

    await Influencer.updateOne(
      { influencerId, 'subscription.features.key': featureKey },
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

  // Ensure used is always a number
  const used = Number(featureObj?.used || 0);
  return { ...featureObj, used: Number.isFinite(used) ? used : 0 };
}

/**
 * POST /apply
 * Body: { campaignId, influencerId }
 * - Records application
 * - Increments influencer plan usage (campaign_applications_per_month)
 * - Updates Campaign applicantCount & hasApplied
 * - Sends:
 *    • Brand notification (apply.submitted) + socket push
 *    • Influencer receipt notification (apply.submitted.self)
 */
exports.applyToCampaign = async (req, res) => {
  const { campaignId, influencerId } = req.body || {};
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    // 0) Validate influencer
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    // 0.1) Validate campaign exists (prevents applying to deleted/invalid id)
    const camp = await Campaign.findOne(
      { campaignsId: campaignId },
      'campaignsId brandId brandName productOrServiceName'
    ).lean();
    if (!camp) return res.status(404).json({ message: 'Campaign not found' });

    // 0.2) Application quota check
    let applyFeature = getFeature(inf, FEATURE_KEYS.APPLY_PER_MONTH);
    if (!applyFeature) {
      return res.status(403).json({
        message: 'Your subscription plan does not permit campaign applications. Please upgrade.'
      });
    }

    applyFeature = await ensureMonthlyWindow(influencerId, FEATURE_KEYS.APPLY_PER_MONTH, applyFeature);

    const applyLimit = readLimit(applyFeature); // 0 => unlimited
    const usedNow = Number(applyFeature.used || 0);

    if (applyLimit > 0 && usedNow >= applyLimit) {
      return res.status(403).json({
        message: `Application limit reached (${applyLimit}). Please upgrade your plan to apply more.`
      });
    }

    // 0.3) Active collaborations cap check (uses plan key: active_collaborations)
    const activeCapFeature = getFeature(inf, FEATURE_KEYS.ACTIVE_COLLABS);
    const activeCap = readLimit(activeCapFeature); // 0 => unlimited
    if (activeCap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= activeCap) {
        return res.status(403).json({
          message: `You’ve reached your active collaborations limit (${activeCap}). Finish/close one or upgrade your plan.`
        });
      }
    }

    // 1) Create/update application (dedupe)
    const existing = await ApplyCampaign.findOne({ campaignId }, 'applicants').lean();
    if (existing?.applicants?.some((a) => String(a.influencerId) === String(influencerId))) {
      return res.status(400).json({ message: 'You have already applied to this campaign' });
    }

    if (!existing) {
      await ApplyCampaign.create({
        campaignId,
        applicants: [{ influencerId, name: inf.name || '' }]
      });
    } else {
      await ApplyCampaign.updateOne(
        { campaignId },
        { $push: { applicants: { influencerId, name: inf.name || '' } } }
      );
    }

    // 2) Increment influencer quota usage (only if not unlimited)
    // (Even for unlimited we can still track usage; harmless.)
    await Influencer.updateOne(
      { influencerId },
      { $inc: { 'subscription.features.$[feat].used': 1 } },
      { arrayFilters: [{ 'feat.key': FEATURE_KEYS.APPLY_PER_MONTH }] }
    );

    // 3) Sync applicantCount + hasApplied on Campaign
    const fresh = await ApplyCampaign.findOne({ campaignId }, 'applicants').lean();
    const applicantCount = fresh?.applicants?.length || 0;

    await Campaign.findOneAndUpdate(
      { campaignsId: campaignId },
      { $set: { applicantCount, hasApplied: 1 } }
    );

    // 4) Brand email + display name
    let brandEmail = null;
    let brandDisplayName = camp?.brandName || '';

    if (camp?.brandId) {
      const brandDoc = await Brand.findOne({ brandId: camp.brandId }, 'email name').lean();
      if (brandDoc) {
        brandEmail = brandDoc.email || null;
        if (!brandDisplayName && brandDoc.name) brandDisplayName = brandDoc.name;
      }
    }

    // 4.1) Send email to brand (non-fatal)
    if (brandEmail) {
      const brandAppBaseUrl = process.env.FRONTEND_ORIGIN || 'https://collabglam.com';
      const subject = `New application for "${camp?.productOrServiceName || 'your campaign'}"`;
      const dashboardLink = `${brandAppBaseUrl}/brand/created-campaign/applied-inf?id=${campaignId}`;

      const plainText = `
Hi ${brandDisplayName || 'there'},

${inf.name || 'An influencer'} has just applied to your campaign "${camp?.productOrServiceName || 'Campaign'}".

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
            <strong>"${camp?.productOrServiceName || 'Campaign'}"</strong>.
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
        await sendMail({ to: brandEmail, subject, text: plainText, html: htmlBody });
      } catch (e) {
        console.warn('Email to brand failed (applyToCampaign):', e?.message || e);
      }
    }

    // 5A) Notify brand (persist + live)
    if (camp?.brandId) {
      try {
        await createAndEmit({
          recipientType: 'brand',
          brandId: String(camp.brandId),
          type: 'apply.submitted',
          title: `New applicant: ${inf.name || 'Influencer'}`,
          message: `${inf.name || 'An influencer'} applied to "${camp.productOrServiceName || 'your campaign'}".`,
          entityType: 'apply',
          entityId: String(campaignId),
          actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
          meta: {
            influencerId,
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
          campaignId: String(camp.campaignsId),
          brandId: String(camp.brandId),
          title: camp.productOrServiceName || '',
          applicant: { influencerId, name: inf.name || '' },
          applicantCount,
          actionPath: `/brand/campaigns/${campaignId}/applicants`
        });
      } catch (e) {
        console.warn('emitToBrand failed:', e?.message || e);
      }
    }

    // 5B) Notify influencer (receipt)
    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.submitted.self',
        title: 'Application sent',
        message: `You applied to "${camp?.productOrServiceName || 'Campaign'}" by ${camp?.brandName || 'Brand'}.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/dashboard/view-campaign?id=${campaignId}`,
        meta: {
          brandId: camp?.brandId || null,
          brandName: camp?.brandName || '',
          productOrServiceName: camp?.productOrServiceName || ''
        }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.submitted.self):', e?.message || e);
    }

    const newUsed = usedNow + 1;
    const unlimited = applyLimit === 0;

    return res.status(200).json({
      message: 'Application recorded',
      campaignId,
      applicantCount,
      hasApplied: 1,

      // ✅ safer for frontend: null means unlimited
      applicationsRemaining: unlimited ? null : Math.max(0, applyLimit - newUsed),
      unlimitedApplications: unlimited,
      applicationsUsedThisWindow: newUsed,
      resetsAt: applyFeature?.resetsAt || null
    });
  } catch (err) {
    console.error('Error in applyToCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /ApplyCampaigns/list — body: { campaignId, ...pagination/sort }
exports.getListByCampaign = async (req, res) => {
  const { campaignId, page = 1, limit = 10, search, sortField, createdPage, sortOrder = 0 } =
    req.body || {};

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    const record = await ApplyCampaign.findOne({ campaignId }).lean();
    if (!record) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        applicantCount: 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const subIdToCatName = await buildSubToParentNameMap();

    // All influencer UUIDs from applicants
    const influencerIds = (record.applicants || [])
      .map((a) => a.influencerId)
      .filter(Boolean)
      .map(String);

    if (!influencerIds.length) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        applicantCount: record.applicants.length,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    const filter = { influencerId: { $in: influencerIds } };
    if (search?.trim()) filter.name = { $regex: search.trim(), $options: 'i' };

    const projection = [
      'influencerId',
      'name',
      'primaryPlatform',
      'onboarding.categoryName',
      'onboarding.subcategories'
    ].join(' ');

    const influencersRaw = await Influencer.find(filter).select(projection).lean();

    if (!influencersRaw.length) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        applicantCount: record.applicants.length,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    // Modash profiles using influencerId only
    const modashProfiles = await Modash.find(
      { influencerId: { $in: influencerIds } },
      'influencerId provider handle username fullname followers'
    ).lean();

    const modashByInf = new Map();
    for (const p of modashProfiles) {
      if (!p.influencerId) continue;
      const key = String(p.influencerId);
      if (!modashByInf.has(key)) modashByInf.set(key, []);
      modashByInf.get(key).push(p);
    }

    function pickModashProfile(profiles = [], primaryPlatform) {
      if (!Array.isArray(profiles) || profiles.length === 0) return null;
      if (primaryPlatform) {
        const hit = profiles.find((p) => p.provider === primaryPlatform);
        if (hit) return hit;
      }
      return (
        profiles
          .slice()
          .sort((a, b) => (Number(b.followers) || 0) - (Number(a.followers) || 0))[0] || null
      );
    }

    const contracts = await Contract.find({ campaignId }).lean();
    const isContractedCampaign = contracts.length > 0 ? 1 : 0;
    const contractByInf = new Map(contracts.map((c) => [String(c.influencerId), c]));
    const approvedId = record.approved?.[0]?.influencerId || null;

    const applicationCreatedAt = record.createdAt || record._id?.getTimestamp?.() || null;

    const condensed = influencersRaw.map((inf) => {
      const infIdStr = String(inf.influencerId);

      // Category name resolution
      let categoryName = inf?.onboarding?.categoryName || '';
      if (!categoryName && Array.isArray(inf?.onboarding?.subcategories)) {
        for (const s of inf.onboarding.subcategories) {
          const cat = subIdToCatName.get(String(s?.subcategoryId));
          if (cat) {
            categoryName = cat;
            break;
          }
        }
      }

      const profiles = modashByInf.get(infIdStr) || [];
      const audienceSize = profiles.reduce((sum, p) => sum + (Number(p?.followers) || 0), 0);
      const chosen = pickModashProfile(profiles, inf.primaryPlatform);

      let handle = null;
      if (chosen) handle = (chosen.handle || chosen.username || chosen.fullname || '').trim() || null;
      if (handle && !handle.startsWith('@')) handle = '@' + handle;

      const c = contractByInf.get(infIdStr);
      const isAssigned = approvedId === inf.influencerId ? 1 : 0;
      const isContracted = c ? 1 : 0;
      const isAccepted = c?.isAccepted === 1 ? 1 : 0;
      const isRejected = c?.isRejected === 1 ? 1 : 0;

      return {
        influencerId: inf.influencerId,
        name: inf.name || '',
        primaryPlatform: inf.primaryPlatform || null,
        handle,
        category: categoryName || null,
        audienceSize,
        createdAt: applicationCreatedAt,

        isAssigned,
        isContracted,
        contractId: c?.contractId || null,
        feeAmount: c?.feeAmount || 0,
        isAccepted,
        isRejected,
        rejectedReason: isRejected ? c?.rejectedReason || '' : ''
      };
    });

    const normalizeStatus = (s) =>
      String(s || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '_');

    const normalizeRole = (s) => String(s || '').trim().toLowerCase();

    let filtered = condensed;

    if (createdPage === true || createdPage === 'true') {
      filtered = condensed.filter((row) => {
        const c = contractByInf.get(String(row.influencerId));
        if (!c) return true;

        const status = normalizeStatus(c.status || c.contractStatus);
        const awaitingRole = normalizeRole(c.awaitingRole || c.awaiting_role || c.awaiting?.role);

        if (status === 'READY_TO_SIGN' && awaitingRole === 'collabglam') return false;
        return true;
      });
    }

    // Sorting
    const dir = sortOrder === 1 ? -1 : 1;
    if (sortField) {
      const allowed = new Set(['name', 'primaryPlatform', 'category', 'audienceSize', 'handle', 'createdAt']);
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

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const start = (pageNum - 1) * limNum;
    const end = start + limNum;

    const total = filtered.length;
    const paged = filtered.slice(start, end);

    return res.status(200).json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },

      applicantCount: createdPage === true || createdPage === 'true' ? total : record.applicants.length,

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
 * - Marks the influencer as approved in ApplyCampaign
 * - Notifies influencer
 */
exports.approveInfluencer = async (req, res) => {
  const { campaignId, influencerId } = req.body || {};
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    // ✅ active collaborations cap uses plan key: active_collaborations
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

    const record = await ApplyCampaign.findOne({ campaignId });
    if (!record) {
      return res.status(404).json({ message: 'No applications found for this campaign' });
    }

    const applicant = (record.applicants || []).find((a) => String(a.influencerId) === String(influencerId));
    if (!applicant) {
      return res.status(400).json({ message: 'Influencer did not apply for this campaign' });
    }

    if (record.approved && record.approved.length > 0) {
      return res.status(400).json({ message: 'An influencer is already approved for this campaign' });
    }

    record.approved = [{ influencerId: applicant.influencerId, name: applicant.name }];
    await record.save();

    const camp = await Campaign.findOne(
      { campaignsId: campaignId },
      'campaignsId productOrServiceName brandName brandId'
    ).lean();

    // Notify influencer
    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.approved',
        title: `Approved for "${camp?.productOrServiceName || 'Campaign'}"`,
        message: `Brand ${camp?.brandName || ''} approved your application.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/campaigns/${campaignId}`,
        meta: { brandId: camp?.brandId || null }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.approved):', e?.message || e);
    }

    // Socket.IO (best-effort)
    const emitToInfluencer = getEmitter(req, 'emitToInfluencer');
    try {
      emitToInfluencer(String(influencerId), 'application:approved', {
        campaignId: String(campaignId),
        title: camp?.productOrServiceName || '',
        brandName: camp?.brandName || '',
        actionPath: `/influencer/campaigns/${campaignId}`
      });
    } catch (e) {
      console.warn('emitToInfluencer failed:', e?.message || e);
    }

    return res.status(200).json({
      message: 'Influencer approved successfully',
      campaignId,
      approved: record.approved?.[0] || null
    });
  } catch (err) {
    console.error('Error in approveInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
