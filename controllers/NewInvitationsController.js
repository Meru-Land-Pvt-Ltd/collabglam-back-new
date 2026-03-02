// controllers/invitationController.js
'use strict';
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const Influencer = require('../models/influencer');
const { EmailThread, EmailMessage } = require('../models/email')
const Brand = require('../models/brand');

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'], ['yt', 'youtube'],
  ['instagram', 'instagram'], ['ig', 'instagram'],
  ['tiktok', 'tiktok'], ['tt', 'tiktok'],
]);
const PLATFORM_ENUM = new Set(['youtube', 'instagram', 'tiktok']);

function normalizeHandle(h) {
  if (!h) return '';
  const t = String(h).trim().toLowerCase();
  return t.startsWith('@') ? t : `@${t}`;
}

const STATUS_ENUM = new Set(['invited', 'available']);

/**
 * POST /invitation/create
 * body: { handle, brandId, platform, status?("invited"|"available"), campaignId? }
 * - Normalizes handle + platform
 * - Stores optional campaignId
 * - No duplicate per (brandId, handle, platform)
 */
exports.createInvitation = async (req, res) => {
  const rawHandle = (req.body?.handle || '').trim();
  const rawBrandId = (req.body?.brandId || '').trim();
  const rawPlatform = (req.body?.platform || '').trim();
  const rawStatus = (req.body?.status || '').trim().toLowerCase();
  const rawCampaignId = (req.body?.campaignId || '').trim();  // 🔥 NEW (optional)

  if (!rawHandle) {
    return res.status(400).json({
      status: 'error',
      message: 'handle is required',
    });
  }
  if (!rawBrandId) {
    return res.status(400).json({
      status: 'error',
      message: 'brandId is required',
    });
  }
  if (!rawPlatform) {
    return res.status(400).json({
      status: 'error',
      message: 'platform is required',
    });
  }

  // normalize handle
  const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`)
    .toLowerCase();
  if (!HANDLE_RX.test(handle)) {
    return res.status(400).json({
      status: 'error',
      message:
        'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
    });
  }

  // normalize platform
  const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
  if (!platform) {
    return res.status(400).json({
      status: 'error',
      message:
        'Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)',
    });
  }

  // status (default invited)
  const status = STATUS_ENUM.has(rawStatus) ? rawStatus : 'invited';

  // Check if invitation already exists for this brand + handle + platform
  let doc = await Invitation.findOne({ brandId: rawBrandId, handle, platform });

  if (doc) {
    let changed = false;

    // 🔥 If a campaignId is provided, update it on existing doc as well
    if (rawCampaignId && doc.campaignId !== rawCampaignId) {
      doc.campaignId = rawCampaignId;
      changed = true;
    }

    // If existing and we are bumping to "available", update
    if (status === 'available' && doc.status !== 'available') {
      doc.status = 'available';
      changed = true;
    }

    if (changed) {
      await doc.save();
    }

    return res.status(200).json({
      status: 'exists',
      message: 'Invitation already exists for this handle & brand.',
      data: {
        invitationId: doc.invitationId,
        handle: doc.handle,
        platform: doc.platform,
        brandId: doc.brandId,
        campaignId: doc.campaignId || null, // 🔥 return campaignId
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    });
  }

  // Create new invitation
  const payload = {
    handle,
    platform,
    brandId: rawBrandId,
    status,
  };

  if (rawCampaignId) {
    payload.campaignId = rawCampaignId; // 🔥 store campaignId if provided
  }

  doc = await Invitation.create(payload);

  return res.status(201).json({
    status: 'saved',
    message: 'Invitation created successfully.',
    data: {
      invitationId: doc.invitationId,
      handle: doc.handle,
      platform: doc.platform,
      brandId: doc.brandId,
      campaignId: doc.campaignId || null, // 🔥 return campaignId
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
  });
};

/**
 * POST /invitation/updateStatus
 * body: { handle, platform, status: "invited" | "available", missingEmailId? }
 */
exports.updateInvitationStatus = async (req, res) => {
  try {
    const rawHandle = (req.body?.handle || '').trim();
    const rawPlatformInput = (req.body?.platform || '').trim().toLowerCase();
    const rawStatus = (req.body?.status || '').trim().toLowerCase();
    const rawMissingEmailId = (req.body?.missingEmailId || '').trim();
    const rawBrandId = (req.body?.brandId || '').trim(); // optional, if you ever send it

    // 1) Validate handle
    if (!rawHandle) {
      return res.status(400).json({
        status: 'error',
        message: 'handle is required',
      });
    }
    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid handle format. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    // 2) Normalize + validate platform (support yt/ig/tt aliases)
    const platform = PLATFORM_MAP.get(rawPlatformInput);
    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid platform. Use "youtube", "instagram" or "tiktok".',
      });
    }

    // 3) Validate status
    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Use "invited" or "available".',
      });
    }

    // 4) Build query: handle + platform (+ optional brandId if provided)
    const query = { handle, platform };
    if (rawBrandId) {
      query.brandId = rawBrandId;
    }

    const doc = await Invitation.findOne(query);
    if (!doc) {
      return res.status(404).json({
        status: 'error',
        message: 'Invitation not found for given handle & platform.',
      });
    }

    // 5) If missingEmailId was provided, validate & link it
    if (rawMissingEmailId) {
      const me = await MissingEmail.findOne(
        { missingEmailId: rawMissingEmailId },
        'missingEmailId handle platform'
      ).lean();

      if (!me) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid missingEmailId. No MissingEmail record found.',
        });
      }

      // Optional sanity checks if you want to be strict:
      // if (me.handle.toLowerCase() !== handle) { ... }
      // if (me.platform !== 'youtube') { ... }

      doc.missingEmailId = me.missingEmailId;
    }

    // 6) Update status
    doc.status = rawStatus;
    await doc.save();

    return res.json({
      status: 'success',
      message: 'Invitation status updated.',
      data: {
        invitationId: doc.invitationId,
        handle: doc.handle,
        platform: doc.platform,
        brandId: doc.brandId,
        campaignId: doc.campaignId || null,
        status: doc.status,
        missingEmailId: doc.missingEmailId || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    console.error('Error in updateInvitationStatus:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

exports.listInvitations = async (req, res) => {
  const body = req.body || {};

  const page = Math.max(1, parseInt(body.page ?? '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

  const rawBrandId = typeof body.brandId === 'string' ? body.brandId.trim() : '';
  const rawHandle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const rawPlatform = typeof body.platform === 'string' ? body.platform.trim() : '';
  const rawStatus = typeof body.status === 'string'
    ? body.status.trim().toLowerCase()
    : '';
  const rawCampaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : ''; // 🔥 NEW

  const query = {};

  // brand filter (optional)
  if (rawBrandId) {
    query.brandId = rawBrandId;
  }

  // campaign filter (optional)
  if (rawCampaignId) {
    query.campaignId = rawCampaignId; // 🔥 allow list by campaign
  }

  // handle filter (optional)
  if (rawHandle) {
    const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`)
      .toLowerCase();

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid handle format in filter',
      });
    }
    query.handle = handle;
  }

  // platform filter (optional, supports aliases yt/ig/tt)
  if (rawPlatform) {
    const p = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!p) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform filter. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)',
      });
    }
    query.platform = p;
  }

  // status filter (optional)
  if (rawStatus && rawStatus !== 'all') {
    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status filter. Use "invited", "available" or "all".',
      });
    }
    query.status = rawStatus;
  }

  const [total, docs] = await Promise.all([
    Invitation.countDocuments(query),
    Invitation.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select({
        _id: 0,
        invitationId: 1,
        handle: 1,
        platform: 1,
        brandId: 1,
        campaignId: 1,     // 🔥 include campaignId
        missingEmailId: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean(),
  ]);

  // 🔥 NEW: join with Campaign to get campaignName
  let data = docs;

  const campaignIds = [
    ...new Set(
      docs
        .map((inv) => inv.campaignId)
        .filter((id) => typeof id === 'string' && id.trim().length > 0)
    ),
  ];

  if (campaignIds.length > 0) {
    // NOTE: Invitation.campaignId stores Campaign.campaignsId
    const campaigns = await Campaign.find({
      campaignsId: { $in: campaignIds },
    })
      .select({
        _id: 0,
        campaignsId: 1,
        productOrServiceName: 1,
      })
      .lean();

    const campaignMap = new Map(
      campaigns.map((c) => [c.campaignsId, c.productOrServiceName])
    );

    data = docs.map((inv) => ({
      ...inv,
      campaignName: inv.campaignId
        ? campaignMap.get(inv.campaignId) || null
        : null,
    }));
  } else {
    // ensure campaignName exists as null for consistency
    data = docs.map((inv) => ({
      ...inv,
      campaignName: null,
    }));
  }

  return res.json({
    page,
    limit,
    total,
    hasNext: page * limit < total,
    data,
  });
};

exports.getInvitationList = async (req, res) => {
  try {
    const rawBrandId =
      (typeof req.body?.brandId === 'string' && req.body.brandId.trim()) ||
      (typeof req.query?.brandId === 'string' && req.query.brandId.trim()) ||
      '';

    if (!rawBrandId) {
      return res.status(400).json({
        status: 'error',
        message: 'brandId is required',
      });
    }

    // 1) Get all invitations for this brand that are linked to a MissingEmail record
    const invitations = await Invitation.find({
      brandId: rawBrandId,
      missingEmailId: { $ne: null },
    })
      .select({
        _id: 0,
        invitationId: 1,
        brandId: 1,
        campaignId: 1,     // 🔥 include campaignId
        missingEmailId: 1,
      })
      .lean();

    if (!invitations.length) {
      return res.json({
        status: 'success',
        message: 'No invitations found for this brand with missingEmailId.',
        data: [],
      });
    }

    // 2) Get all MissingEmail docs for those missingEmailIds
    const missingIds = [
      ...new Set(
        invitations
          .map((inv) => inv.missingEmailId)
          .filter(Boolean)
      ),
    ];

    const missingDocs = await MissingEmail.find({
      missingEmailId: { $in: missingIds },
    })
      .select({
        _id: 0,
        missingEmailId: 1,
        handle: 1,
        youtube: 1, // contains youtube.title if present
      })
      .lean();

    // 3) Build a map missingEmailId -> MissingEmail doc
    const missingMap = new Map();
    for (const me of missingDocs) {
      missingMap.set(me.missingEmailId, me);
    }

    // 4) Build response list with title resolved from MissingEmail
    const data = invitations.map((inv) => {
      const me = missingMap.get(inv.missingEmailId);
      const title =
        (me && me.youtube && me.youtube.title) ||
        (me && me.handle) ||
        '';

      return {
        invitationId: inv.invitationId,
        missingEmailId: inv.missingEmailId,
        campaignId: inv.campaignId || null, // 🔥 expose campaignId
        title,
      };
    });

    return res.json({
      status: 'success',
      message: 'Invitation list fetched successfully.',
      data,
    });
  } catch (err) {
    console.error('Error in getInvitationList:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

const COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48 hours

async function computeBrandEligibilityForThread(threadId) {
  const messages = await EmailMessage.find({ thread: threadId })
    .select('direction createdAt sentAt')
    .sort({ createdAt: 1 })
    .lean();

  const hasIncoming = messages.some((m) => m.direction === 'influencer_to_brand');
  if (hasIncoming) {
    return {
      canSend: true,
      state: 'allowed',
      reason: 'Influencer replied — messaging is unlocked.',
      nextAllowedAt: null,
      outgoingCount: messages.filter(m => m.direction === 'brand_to_influencer').length,
    };
  }

  const outgoing = messages.filter((m) => m.direction === 'brand_to_influencer');
  const outgoingCount = outgoing.length;

  if (outgoingCount === 0) {
    return {
      canSend: true,
      state: 'allowed',
      reason: 'First email allowed.',
      nextAllowedAt: null,
      outgoingCount,
    };
  }

  if (outgoingCount === 1) {
    const firstAt = new Date(outgoing[0].sentAt || outgoing[0].createdAt).getTime();
    const nextAllowedAt = new Date(firstAt + COOLDOWN_MS);

    if (Date.now() >= nextAllowedAt.getTime()) {
      return {
        canSend: true,
        state: 'allowed',
        reason: '48 hours passed — follow-up allowed.',
        nextAllowedAt: null,
        outgoingCount,
      };
    }

    return {
      canSend: false,
      state: 'cooldown',
      reason: 'Wait 48 hours before sending a follow-up (no reply yet).',
      nextAllowedAt: nextAllowedAt.toISOString(),
      outgoingCount,
    };
  }

  return {
    canSend: false,
    state: 'blocked',
    reason: 'You already sent 2 emails without a reply. You can message again only after the influencer replies.',
    nextAllowedAt: null,
    outgoingCount,
  };
}

// ✅ POST /emails/invitation/eligibility
exports.getInvitationSendEligibility = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || '').trim();
    const invitationId = String(req.body?.invitationId || '').trim();

    if (!brandId || !invitationId) {
      return res.status(400).json({
        canSend: false,
        state: 'missing_email',
        reason: 'brandId and invitationId are required.',
        nextAllowedAt: null,
      });
    }

    const brand = await Brand.findOne({ brandId }).lean();
    if (!brand) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Brand not found.',
        nextAllowedAt: null,
      });
    }

    const invitation = await Invitation.findOne({ invitationId }).lean();
    if (!invitation) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Invitation not found.',
        nextAllowedAt: null,
      });
    }

    // Ensure this invitation belongs to this brand
    if (invitation.brandId && invitation.brandId !== (brand.brandId || String(brand._id))) {
      return res.status(403).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Invitation does not belong to this brand.',
        nextAllowedAt: null,
      });
    }

    if (!invitation.missingEmailId) {
      return res.status(200).json({
        canSend: false,
        state: 'missing_email',
        reason: 'No email resolved yet for this invitation.',
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const missing = await MissingEmail.findOne({ missingEmailId: invitation.missingEmailId }).lean();
    const recipientEmail = (missing?.email || '').toLowerCase().trim();

    if (!recipientEmail) {
      return res.status(200).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Recipient email not found yet for this invitation.',
        nextAllowedAt: null,
        threadId: null,
      });
    }

    // Find influencer by email WITHOUT creating new docs
    const influencer = await Influencer.findOne({ email: recipientEmail }).select('_id').lean();
    if (!influencer) {
      // no thread yet => first email allowed
      return res.status(200).json({
        canSend: true,
        state: 'allowed',
        reason: 'First email allowed.',
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const thread = await EmailThread.findOne({ brand: brand._id, influencer: influencer._id })
      .select('_id')
      .lean();

    if (!thread) {
      return res.status(200).json({
        canSend: true,
        state: 'allowed',
        reason: 'First email allowed.',
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const eligibility = await computeBrandEligibilityForThread(thread._id);

    return res.status(200).json({
      ...eligibility,
      threadId: String(thread._id),
    });
  } catch (err) {
    console.error('getInvitationSendEligibility error:', err);
    return res.status(500).json({
      canSend: false,
      state: 'missing_email',
      reason: 'Internal server error.',
      nextAllowedAt: null,
    });
  }
};
