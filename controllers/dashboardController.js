// controllers/dashboardController.js
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = process.env;

const Brand = require("../models/brand");
const Campaign = require("../models/campaign");
const Influencer = require("../models/influencer");
const Milestone = require("../models/milestone");
const Contract = require("../models/contract");
const ApplyCampaign = require("../models/applyCampaign");

const { CONTRACT_STATUS } = require("../constants/contract");

/**
 * Generic JWT verifier — populates req.user with the decoded token.
 */
exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ message: "Token required" });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

/**
 * ✅ IMPORTANT:
 * These filters make sure rejected/superseded contracts are not counted anywhere,
 * even if they were previously accepted/assigned.
 */
function baseActiveContractGuard() {
  return {
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [
      { supersededBy: { $exists: false } },
      { supersededBy: null },
      { supersededBy: "" },
    ],
  };
}

function acceptedContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: 1,
    isAccepted: 1,
    ...baseActiveContractGuard(),
  };
}

function pendingContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: 1,
    isAccepted: 0,
    ...baseActiveContractGuard(),
  };
}

/**
 * Brand dashboard (basic):
 */
exports.getDashboard = async (req, res) => {
  try {
    const { brandId } = req.body || {};
    if (!brandId) return res.status(400).json({ error: "brandId is required" });

    // 1) Fetch brand
    const brand = await Brand.findOne({ brandId }).lean();
    if (!brand) {
      return res.status(404).json({ error: "Brand not found" });
    }

    // 2) All campaigns for this brand
    const campaigns = await Campaign.find(
      { brandId },
      "campaignsId isActive"
    ).lean();

    const totalCreatedCampaigns = campaigns.length;

    const activeCampaignIds = campaigns
      .filter((c) => Number(c.isActive) === 1)
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    // 3) Total hired influencers from ACTIVE campaigns (distinct)
    // ✅ Excludes rejected/superseded contracts
    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length > 0) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            brandId,
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);

      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 4) Total influencers who have milestones with this brand
    const milestoneAgg = await Milestone.aggregate([
      { $match: { brandId } },
      { $unwind: "$milestoneHistory" },
      { $group: { _id: "$milestoneHistory.influencerId" } },
      { $count: "total" },
    ]);
    const totalMilestoneInfluencers = milestoneAgg?.[0]?.total || 0;

    // 5) Budget remaining (brand wallet)
    const milestoneDoc = await Milestone.findOne(
      { brandId },
      "walletBalance"
    ).lean();
    const budgetRemaining = Number(milestoneDoc?.walletBalance ?? 0);

    return res.status(200).json({
      brandName: brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalMilestoneInfluencers,
      budgetRemaining,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/**
 * Influencer dashboard:
 * - Requires req.user.influencerId
 */
exports.getDashboardInf = async (req, res) => {
  try {
    const { influencerId } = req.user || {};
    if (!influencerId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const now = new Date();

    // 2) Pending approvals = assigned but not accepted
    // ✅ Excludes rejected/superseded
    const pendingApprovals = await Contract.countDocuments(
      pendingContractFilter({ influencerId })
    );

    // 3) Accepted contracts → decide “active” by campaign timeline
    // ✅ Excludes rejected/superseded even if previously accepted
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ influencerId }),
      "campaignId"
    ).lean();

    const acceptedCampaignIds = acceptedContracts
      .map((c) => String(c.campaignId || ""))
      .filter(Boolean);

    const activeCampaigns = acceptedCampaignIds.length
      ? await Campaign.countDocuments({
          campaignsId: { $in: acceptedCampaignIds },
          "timeline.startDate": { $lte: now },
          $or: [
            { "timeline.endDate": { $exists: false } },
            { "timeline.endDate": null },
            { "timeline.endDate": { $gte: now } },
          ],
        })
      : 0;

    // 4a) Total earnings from all released milestones
    const [releasedAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": true,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    // 4b) Upcoming payouts = sum of all unreleased milestones
    const [upcomingAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": false,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    const totalEarnings = releasedAgg?.total || 0;
    const upcomingPayouts = upcomingAgg?.total || 0;

    return res.status(200).json({
      influencerId,
      activeCampaigns,
      pendingApprovals,
      totalEarnings,
      upcomingPayouts,
    });
  } catch (err) {
    console.error("Error in getDashboardInf:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandDashboardHome = async (req, res) => {
  try {
    const { brandId } = req.body || {};
    if (!brandId) return res.status(400).json({ error: "brandId is required" });

    // 1) Brand
    const brand = await Brand.findOne({ brandId }, "name brandId").lean();
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    // 2) All campaigns (non-draft)
    const allCampaigns = await Campaign.find(
      { brandId, isDraft: { $ne: 1 } },
      "campaignsId productOrServiceName goal budget isActive createdAt"
    )
      .sort({ createdAt: -1 })
      .lean();

    const totalCreatedCampaigns = allCampaigns.length;

    const campaignIds = allCampaigns
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    // 3) Accepted contracts → latest per campaign
    // ✅ Excludes rejected/superseded
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ brandId }),
      "campaignId contractId influencerId lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const contractByCampaign = new Map(); // campaignId -> { contractId, influencerId }
    for (const c of acceptedContracts) {
      const key = String(c.campaignId || "");
      if (!key) continue;
      if (!contractByCampaign.has(key)) {
        contractByCampaign.set(key, {
          contractId: c.contractId || null,
          influencerId: c.influencerId || null,
        });
      }
    }

    const acceptedCampaignIds = new Set(Array.from(contractByCampaign.keys()));
    const acceptedCount = acceptedCampaignIds.size;

    // 4) Applied influencers per campaign + total sum across campaigns
    const appliedCountMap = new Map();
    let totalAppliedInfluencers = 0;

    if (campaignIds.length) {
      const agg = await ApplyCampaign.aggregate([
        { $match: { campaignId: { $in: campaignIds } } },
        { $unwind: "$applicants" },

        // unique per campaign
        {
          $group: {
            _id: {
              campaignId: "$campaignId",
              influencerId: "$applicants.influencerId",
            },
          },
        },

        // count per campaign
        {
          $group: {
            _id: "$_id.campaignId",
            appliedInfluencersCount: { $sum: 1 },
          },
        },

        // total is sum of per-campaign counts
        {
          $facet: {
            perCampaign: [{ $project: { _id: 1, appliedInfluencersCount: 1 } }],
            total: [
              {
                $group: {
                  _id: null,
                  totalAppliedInfluencers: { $sum: "$appliedInfluencersCount" },
                },
              },
            ],
          },
        },
      ]);

      const perCampaign = agg?.[0]?.perCampaign || [];
      const total = agg?.[0]?.total?.[0]?.totalAppliedInfluencers || 0;

      totalAppliedInfluencers = Number(total) || 0;

      perCampaign.forEach((row) => {
        appliedCountMap.set(String(row._id), Number(row.appliedInfluencersCount || 0));
      });
    }

    // 5) Show list rule
    const anyUnaccepted = allCampaigns.some((camp) => {
      const id = String(camp.campaignsId || "");
      return id && !acceptedCampaignIds.has(id);
    });

    const showAll = acceptedCount === 0 || anyUnaccepted;
    const campaignsMode = showAll ? "all" : "accepted";

    const baseList = showAll
      ? allCampaigns
      : allCampaigns.filter((c) => acceptedCampaignIds.has(String(c.campaignsId || "")));

    const campaigns = baseList.map((c) => {
      const id = String(c.campaignsId || "");
      const meta = contractByCampaign.get(id) || {};
      return {
        id,
        campaignsId: id,
        productOrServiceName: c.productOrServiceName || "",
        goal: c.goal || "",
        budget: Number(c.budget || 0),
        isActive: Number(c.isActive || 0),
        createdAt: c.createdAt || null,

        hasAcceptedInfluencer: acceptedCampaignIds.has(id),
        influencerId: meta.influencerId ?? null,
        contractId: meta.contractId ?? null,

        appliedInfluencersCount: appliedCountMap.get(id) || 0,
      };
    });

    // 6) Total hired influencers (distinct) from ACTIVE campaigns only
    // ✅ Excludes rejected/superseded
    const activeCampaignIds = allCampaigns
      .filter((c) => Number(c.isActive) === 1)
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            brandId,
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);
      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 7) Budget remaining
    const milestone = await Milestone.findOne({ brandId }, "walletBalance").lean();
    const budgetRemaining = Number(milestone?.walletBalance ?? 0);

    return res.status(200).json({
      brandName: brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalAppliedInfluencers,
      budgetRemaining,
      campaignsMode,
      campaigns,
    });
  } catch (err) {
    console.error("getBrandDashboardHome error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
