// controllers/milestoneController.js

const Milestone = require('../models/milestone');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const { createAndEmit } = require('../utils/notifier');
const Contract = require('../models/contract');
const { CONTRACT_STATUS } = require('../constants/contract');

// ✉️ Email helpers
const {
  sendMilestoneCreatedEmail,
  sendMilestoneReleasedEmail,
  sendMilestonePaidEmail,
} = require('../emails/milestonetemplet');

// Helper to build app URL
const APP_BASE_URL = process.env.APP_BASE_URL || '';

// 2% Razorpay fee (can be overridden from env)
const RAZORPAY_FEE_PERCENT = Number(process.env.RAZORPAY_FEE_PERCENT || 0.02);

/**
 * POST /milestone/create
 * body: { brandId, influencerId, campaignId, milestoneTitle, amount, milestoneDescription, razorpayOrderId?, razorpayPaymentId? }
 */
exports.createMilestone = async (req, res) => {
  const {
    brandId,
    influencerId,
    campaignId,
    milestoneTitle,
    amount,
    milestoneDescription = '',
    razorpayOrderId = null,
    razorpayPaymentId = null,
  } = req.body;

  const amountNum = Number(amount);

  if (!brandId || !influencerId || !campaignId || !milestoneTitle || amount == null) {
    return res.status(400).json({
      message: 'brandId, influencerId, campaignId, milestoneTitle and amount are required',
    });
  }

  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ message: 'amount must be a valid number > 0' });
  }

  try {
    // 1) Verify campaign
    const camp = await Campaign.findOne({ campaignsId: campaignId }).lean();
    if (!camp) return res.status(404).json({ message: 'Campaign not found' });

    // 2) Find current contract (prefer campaign.contractId)
    let contractDoc = null;
    if (camp.contractId) {
      contractDoc = await Contract.findOne({ contractId: camp.contractId });
    }
    if (!contractDoc) {
      contractDoc = await Contract.findOne({ brandId, influencerId, campaignId })
        .sort({ createdAt: -1 });
    }

    // 3) Load / create brand milestone doc
    let doc = await Milestone.findOne({ brandId });
    if (!doc) doc = new Milestone({ brandId });

    doc.walletBalance = Number(doc.walletBalance || 0);
    doc.totalAmount = Number(doc.totalAmount || 0);

    // 4) Block if previous milestone for same influencer+campaign not released
    const prev = doc.milestoneHistory.filter(
      (e) => e.influencerId === influencerId && e.campaignId === campaignId
    );

    if (prev.length > 0) {
      prev.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const last = prev[0];
      if (!last.released) {
        return res.status(400).json({
          message: 'Cannot create new milestone until the previous milestone is released',
        });
      }
    }

    // 5) Campaign budget enforcement (same as your logic, but safe)
    const campaignBudget = Number(camp.budget);
    const hasBudget = !isNaN(campaignBudget) && campaignBudget > 0;

    if (hasBudget) {
      const existingTotalForCampaign = doc.milestoneHistory
        .filter((e) => e.campaignId === campaignId)
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

      if (existingTotalForCampaign >= campaignBudget) {
        return res.status(400).json({
          message: 'You have added milestone equal to campaign now not able to add now milestone',
        });
      }

      if (existingTotalForCampaign + amountNum > campaignBudget) {
        return res.status(400).json({
          message: 'Total milestone amount cannot exceed campaign budget',
        });
      }
    }

    // 6) Razorpay fee calc
    const feePercent =
      !isNaN(RAZORPAY_FEE_PERCENT) && RAZORPAY_FEE_PERCENT >= 0
        ? RAZORPAY_FEE_PERCENT
        : 0.02;

    const razorpayFee = Math.round(amountNum * feePercent * 100) / 100;
    const totalWithFee = amountNum + razorpayFee;

    // 7) Create entry
    const entry = {
      influencerId,
      campaignId,
      milestoneTitle,
      amount: amountNum,
      milestoneDescription,
      released: false,
      createdAt: new Date(),
      razorpayFee,
      totalWithFee,
      razorpayOrderId,
      razorpayPaymentId,
    };

    doc.milestoneHistory.push(entry);

    // escrow wallet uses base amount only
    doc.walletBalance = doc.walletBalance + amountNum;
    doc.totalAmount = doc.totalAmount + amountNum;

    await doc.save();

    // 8) ✅ SET CONTRACT STATUS ON FIRST MILESTONE CREATION
    let updatedContract = null;

    if (contractDoc) {
      // Optional: enforce that milestones can only be created after signing
      const st = String(contractDoc.status || "").toUpperCase();
      const canCreateMilestone =
        st === CONTRACT_STATUS.CONTRACT_SIGNED ||
        st === CONTRACT_STATUS.MILESTONES_CREATED;

      if (!canCreateMilestone) {
        return res.status(400).json({
          message: "Contract must be fully signed before creating milestones.",
        });
      }

      const alreadyMilestonesLocked = st === CONTRACT_STATUS.MILESTONES_CREATED;

      if (!alreadyMilestonesLocked) {
        contractDoc.status = CONTRACT_STATUS.MILESTONES_CREATED;
        contractDoc.milestonesCreatedAt = contractDoc.milestonesCreatedAt || new Date();
        contractDoc.awaitingRole = null;

        contractDoc.statusFlags = contractDoc.statusFlags || {};
        contractDoc.statusFlags.awaitingCollabglam = false;

        contractDoc.audit = contractDoc.audit || [];
        contractDoc.audit.push({
          type: "MILESTONES_CREATED",
          role: "system",
          details: { brandId, influencerId, campaignId },
          at: new Date(),
        });

        await contractDoc.save();
      }

      updatedContract = contractDoc;

      // Keep Campaign in sync for UI convenience
      await Campaign.updateOne(
        { campaignsId: campaignId },
        {
          $set: {
            contractId: contractDoc.contractId,
            isContracted: 1,
            contractStatus: contractDoc.status, // ✅ now MILESTONES_CREATED
            milestonesCreatedAt: contractDoc.milestonesCreatedAt || new Date(),
          },
        }
      );
    }

    // 9) Notifications + Email (your existing logic unchanged)
    createAndEmit({
      influencerId,
      type: 'milestone.created',
      title: `New milestone: ${milestoneTitle}`,
      message: `An amount of $${amountNum.toFixed(2)} was created for this campaign.`,
      entityType: 'campaign',
      entityId: String(campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error('notify influencer (created) failed:', e));

    createAndEmit({
      brandId,
      type: 'milestone.created',
      title: `Milestone created for influencer ${influencerId}`,
      message: `${milestoneTitle} • $${amountNum.toFixed(2)}`,
      entityType: 'campaign',
      entityId: String(campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error('notify brand (created) failed:', e));

    // email section unchanged (keep your existing try/catch block)
    try {
      const [infDoc, brandDoc] = await Promise.all([
        Influencer.findOne({ influencerId }, 'name email').lean(),
        Brand.findOne({ brandId }, 'name').lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneCreatedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || '',
          brandName: (brandDoc && brandDoc.name) || '',
          campaignName: camp.productOrServiceName || '',
          milestoneTitle,
          amount: amountNum,
          milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error('sendMilestoneCreatedEmail failed:', e));
      }
    } catch (emailErr) {
      console.error('Error preparing milestone created email:', emailErr);
    }

    // 10) ✅ Response includes contractStatus
    return res.status(201).json({
      message: 'Milestone created',
      milestoneId: doc.milestoneId,
      walletBalance: doc.walletBalance,
      totalAmount: doc.totalAmount,
      payment: {
        baseAmount: amountNum,
        razorpayFee,
        totalWithFee,
        feePercent,
      },
      entry,
      contractStatus: updatedContract?.status || contractDoc?.status || null,
      milestonesCreatedAt: updatedContract?.milestonesCreatedAt || contractDoc?.milestonesCreatedAt || null,
    });
  } catch (err) {
    console.error('Error in createMilestone:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/listByCampaign
 * body: { campaignId }
 */
exports.getMilestonesByCampaign = async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).json({ message: "campaignId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.campaignId": String(campaignId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.campaignId) === String(campaignId))
        .map((e) => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
          walletBalance: doc.walletBalance,
        }))
    );

    // ✅ influencerIds are UUID strings, so query by influencerId (NOT _id)
    const influencerIds = [
      ...new Set(
        entries
          .map((e) => e.influencerId)
          .filter(Boolean)
          .map(String)
      ),
    ];

    const influencers = influencerIds.length
      ? await Influencer.find(
          { influencerId: { $in: influencerIds } },
          "influencerId name fullName username"
        ).lean()
      : [];

    const influencerMap = new Map(
      influencers.map((u) => [
        String(u.influencerId),
        u.name || u.fullName || u.username || null,
      ])
    );

    const entriesWithNames = entries.map((e) => ({
      ...e,
      influencerName: e.influencerId
        ? influencerMap.get(String(e.influencerId)) || null
        : null,
    }));

    entriesWithNames.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.status(200).json({
      message: "Milestones fetched by campaign",
      milestones: entriesWithNames,
    });
  } catch (err) {
    console.error("Error in getMilestonesByCampaign:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /milestone/listByInfluencerAndCampaign
 * body: { influencerId, campaignId }
 */
exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  const { influencerId, campaignId, brandId } = req.body;

  if (!influencerId || !campaignId) {
    return res.status(400).json({ message: "influencerId and campaignId are required" });
  }

  try {
    const filter = {
      milestoneHistory: {
        $elemMatch: {
          influencerId: String(influencerId),
          campaignId: String(campaignId),
        },
      },
    };

    // ✅ optional: if brandId is available, keep it tight
    if (brandId) filter.brandId = String(brandId);

    const docs = await Milestone.find(filter).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter(
          (e) =>
            String(e.influencerId) === String(influencerId) &&
            String(e.campaignId) === String(campaignId)
        )
        .map((e) => {
          let payoutStatus = e.payoutStatus;
          if (!payoutStatus) payoutStatus = e.released ? "initiated" : "pending";

          return {
            ...e,
            payoutStatus,
            brandId: doc.brandId,
            milestoneId: doc.milestoneId,
            walletBalance: doc.walletBalance,
          };
        })
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by influencer and campaign",
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByInfluencerAndCampaign:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /milestone/listByInfluencer
 * body: { influencerId }
 */
exports.getMilestonesByInfluencer = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    const docs = await Milestone.find({
      'milestoneHistory.influencerId': influencerId,
    }).lean();

    const entries = docs.flatMap((doc) =>
      doc.milestoneHistory
        .filter((e) => e.influencerId === influencerId)
        .map((e) => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
          walletBalance: doc.walletBalance,
        }))
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by influencer',
      milestones: entries,
    });
  } catch (err) {
    console.error('Error in getMilestonesByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/listByBrand
 * body: { brandId }
 */
exports.getMilestonesByBrand = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    const doc = await Milestone.findOne({ brandId }).lean();
    if (!doc) {
      return res.status(200).json({
        message: 'No milestones found for this brand',
        milestones: [],
      });
    }

    const entries = doc.milestoneHistory.map((e) => ({
      ...e,
      brandId: doc.brandId,
      milestoneId: doc.milestoneId,
      walletBalance: doc.walletBalance,
    }));

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by brand',
      milestones: entries,
    });
  } catch (err) {
    console.error('Error in getMilestonesByBrand:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/balance
 * body: { brandId }
 */
exports.getWalletBalance = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    const doc = await Milestone.findOne({ brandId }).lean();
    const balance = doc ? doc.walletBalance : 0;
    return res.status(200).json({
      message: 'Wallet balance fetched',
      brandId,
      balance,
    });
  } catch (err) {
    console.error('Error in getWalletBalance:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/release
 * body: { milestoneId, milestoneHistoryId }
 */
exports.releaseMilestone = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;
  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: 'milestoneId and milestoneHistoryId are required.',
    });
  }

  try {
    const doc = await Milestone.findOne({ milestoneId });
    if (!doc) {
      return res.status(404).json({ message: 'Milestone not found.' });
    }

    const entry = doc.milestoneHistory.find(
      (h) => h.milestoneHistoryId === milestoneHistoryId
    );
    if (!entry) {
      return res
        .status(404)
        .json({ message: 'Milestone history entry not found.' });
    }
    if (entry.released) {
      return res
        .status(400)
        .json({ message: 'This milestone has already been released.' });
    }

    // brand releases funds from its wallet
    doc.walletBalance = Math.max(0, (doc.walletBalance || 0) - Number(entry.amount || 0));
    entry.released = true;
    entry.releasedAt = new Date();

    // admin flow → mark payout as INITIATED
    entry.payoutStatus = 'initiated';

    await doc.save();

    // Notifications (non-blocking)
    // Influencer → they see "Initiated"
    createAndEmit({
      influencerId: entry.influencerId,
      type: 'milestone.initiated',
      title: `Milestone payout initiated${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''
        }`,
      message:
        `Brand has released $${Number(entry.amount).toFixed(
          2
        )} for this campaign. ` +
        `It should be received within 24 - 48 hrs.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error('notify influencer (initiated) failed:', e));

    // Brand → they see release in their own history
    createAndEmit({
      brandId: doc.brandId,
      type: 'milestone.released',
      title: `Milestone released${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''
        }`,
      message: `You released $${Number(entry.amount).toFixed(
        2
      )} for this campaign.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error('notify brand (released) failed:', e));

    // ✉️ Email to influencer: payout initiated
    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne(
          { influencerId: entry.influencerId },
          'name email'
        ).lean(),
        Brand.findOne({ brandId: doc.brandId }, 'name').lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          'productOrServiceName'
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneReleasedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || '',
          brandName: (brandDoc && brandDoc.name) || '',
          campaignName: (campDoc && campDoc.productOrServiceName) || '',
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error('sendMilestoneReleasedEmail failed:', e));
      }
    } catch (emailErr) {
      console.error('Error preparing milestone released email:', emailErr);
    }

    return res.status(200).json({
      message: 'Milestone released successfully (payout initiated).',
      releasedAmount: entry.amount,
      payoutStatus: entry.payoutStatus,
    });
  } catch (err) {
    console.error('Error in releaseMilestone:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * POST /milestone/paidTotal
 * body: { influencerId }
 */
exports.getInfluencerPaidTotal = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required.' });
  }
  try {
    const docs = await Milestone.find({
      'milestoneHistory.influencerId': influencerId,
    });

    let totalPaid = 0;
    docs.forEach((d) => {
      d.milestoneHistory
        .filter(
          (e) =>
            e.influencerId === influencerId && e.payoutStatus === 'paid'
        )
        .forEach((e) => {
          totalPaid += Number(e.amount) || 0;
        });
    });
    return res.json({ influencerId, totalPaid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * POST /milestone/adminListPayouts
 * body: { status = 'all' | 'initiated' | 'paid' | [...], page, limit }
 */
exports.adminListPayouts = async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 20 } = req.body || {};

    const pageNum = Number(page) || 1;
    const limitNum = Math.max(1, Number(limit) || 20);

    // Normalize status into either "all" or an array of strings
    let statusFilter;
    if (
      status === 'all' ||
      status === undefined ||
      status === null ||
      status === ''
    ) {
      statusFilter = 'all';
    } else if (Array.isArray(status)) {
      statusFilter = status.map(String);
    } else {
      statusFilter = [String(status)];
    }

    const baseQuery = { 'milestoneHistory.released': true };
    const docs = await Milestone.find(baseQuery).lean();

    let entries = docs.flatMap((doc) =>
      doc.milestoneHistory
        .filter((e) => e.released)
        .map((e) => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
        }))
    );

    // If statusFilter is not "all", filter by payoutStatus
    if (statusFilter !== 'all') {
      entries = entries.filter((e) =>
        statusFilter.includes(e.payoutStatus || 'initiated')
      );
    }

    // latest first
    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = entries.length;
    const totalPages = Math.ceil(total / limitNum);
    const start = (pageNum - 1) * limitNum;
    const dataPage = entries.slice(start, start + limitNum);

    // collect ids for lookups
    const brandIds = [...new Set(dataPage.map((e) => e.brandId))];
    const influencerIds = [...new Set(dataPage.map((e) => e.influencerId))];
    const campaignIds = [...new Set(dataPage.map((e) => e.campaignId))];

    const [brands, influencers, campaigns] = await Promise.all([
      Brand.find({ brandId: { $in: brandIds } }, 'brandId name').lean(),
      Influencer.find(
        { influencerId: { $in: influencerIds } },
        'influencerId name email'
      ).lean(),
      Campaign.find(
        { campaignsId: { $in: campaignIds } },
        'campaignsId productOrServiceName'
      ).lean(),
    ]);

    const brandMap = new Map(brands.map((b) => [b.brandId, b.name]));
    const influencerMap = new Map(
      influencers.map((i) => [i.influencerId, { name: i.name, email: i.email }])
    );
    const campaignMap = new Map(
      campaigns.map((c) => [c.campaignsId, c.productOrServiceName])
    );

    const items = dataPage.map((e) => {
      const inf = influencerMap.get(e.influencerId) || {};
      return {
        milestoneId: e.milestoneId,
        milestoneHistoryId: e.milestoneHistoryId,
        brandId: e.brandId,
        brandName: brandMap.get(e.brandId) || null,
        influencerId: e.influencerId,
        influencerName: inf.name || null,
        influencerEmail: inf.email || null,
        campaignId: e.campaignId,
        campaignTitle: campaignMap.get(e.campaignId) || null,
        amount: e.amount,
        razorpayFee: e.razorpayFee,
        totalWithFee: e.totalWithFee,
        payoutStatus: e.payoutStatus, // "initiated" | "paid"
        releasedAt: e.releasedAt,
        createdAt: e.createdAt,
      };
    });

    return res.status(200).json({
      message: 'Milestone payouts for admin',
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      items,
    });
  } catch (err) {
    console.error('Error in adminListPayouts:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/adminMarkMilestonePaid
 * body: { milestoneId, milestoneHistoryId }
 */
exports.adminMarkMilestonePaid = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: 'milestoneId and milestoneHistoryId are required.',
    });
  }

  try {
    const doc = await Milestone.findOne({ milestoneId });
    if (!doc) {
      return res.status(404).json({ message: 'Milestone not found.' });
    }

    const entry = doc.milestoneHistory.find(
      (h) => h.milestoneHistoryId === milestoneHistoryId
    );
    if (!entry) {
      return res
        .status(404)
        .json({ message: 'Milestone history entry not found.' });
    }

    if (!entry.released) {
      return res.status(400).json({ message: 'Milestone not released yet.' });
    }

    if (entry.payoutStatus === 'paid') {
      return res
        .status(400)
        .json({ message: 'This milestone is already marked as paid.' });
    }

    entry.payoutStatus = 'paid';
    entry.paidAt = new Date();

    await doc.save();

    // notify influencer → PAID
    createAndEmit({
      influencerId: entry.influencerId,
      type: 'milestone.paid',
      title: `Milestone paid${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''
        }`,
      message: `Your payout of $${Number(entry.amount).toFixed(
        2
      )} has been approved and marked as paid.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error('notify influencer (paid) failed:', e));

    // notify brand
    createAndEmit({
      brandId: doc.brandId,
      type: 'milestone.paid',
      title: `Payout completed`,
      message: `${entry.milestoneTitle || 'Milestone'
        } of $${Number(entry.amount).toFixed(2)} has been marked as paid.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error('notify brand (paid) failed:', e));

    // ✉️ Email to influencer: payout completed
    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne(
          { influencerId: entry.influencerId },
          'name email'
        ).lean(),
        Brand.findOne({ brandId: doc.brandId }, 'name').lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          'productOrServiceName'
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestonePaidEmail({
          to: infDoc.email,
          influencerName: infDoc.name || '',
          brandName: (brandDoc && brandDoc.name) || '',
          campaignName: (campDoc && campDoc.productOrServiceName) || '',
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error('sendMilestonePaidEmail failed:', e));
      }
    } catch (emailErr) {
      console.error('Error preparing milestone paid email:', emailErr);
    }

    return res.status(200).json({
      message: 'Milestone marked as paid.',
      payoutStatus: entry.payoutStatus,
    });
  } catch (err) {
    console.error('Error in adminMarkMilestonePaid:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
