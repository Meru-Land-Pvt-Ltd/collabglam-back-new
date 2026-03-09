// controllers/dashboardController.js
require("dotenv").config();

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = process.env;

const Brand = require("../models/brand");
const Campaign = require("../models/campaign");
const Influencer = require("../models/influencer");
const Milestone = require("../models/milestone");
const Contract = require("../models/contract");
const ApplyCampaign = require("../models/applyCampaign");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");

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

// ------------------------- helpers -------------------------

function toObjectIdStrict(id, fieldName = "brandId") {
  const clean = String(id || "").trim();
  if (!mongoose.isValidObjectId(clean)) {
    const err = new Error(`${fieldName} is invalid`);
    err.status = 400;
    throw err;
  }
  return new mongoose.Types.ObjectId(clean);
}

/**
 * During migration some collections may store brandId as ObjectId,
 * and some might still store as string. This returns both variants.
 */
function brandIdVariants(brandObjectId) {
  const oid = brandObjectId instanceof mongoose.Types.ObjectId
    ? brandObjectId
    : new mongoose.Types.ObjectId(String(brandObjectId));
  return [oid, oid.toString()];
}

function brandFilter(field, brandObjectId) {
  return { [field]: { $in: brandIdVariants(brandObjectId) } };
}

/**
 * ✅ IMPORTANT:
 * These filters make sure rejected/superseded contracts are not counted anywhere,
 * even if they were previously accepted/assigned.
 */
function baseActiveContractGuard() {
  return {
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
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

// ------------------------- controllers -------------------------

/**
 * Brand dashboard (basic)
 * brandId = Brand._id (ObjectId string)
 */
exports.getDashboard = async (req, res) => {
  try {
    const brandIdRaw = req.body?.brandId || req.user?.brandId;
    if (!brandIdRaw) return res.status(400).json({ error: "brandId is required" });

    const brandObjectId = toObjectIdStrict(brandIdRaw, "brandId");

    // 1) Fetch brand by _id
    const brand = await Brand.findById(brandObjectId).lean();
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    // 2) All campaigns for this brand
    const campaigns = await Campaign.find(brandFilter("brandId", brandObjectId), "campaignsId isActive").lean();
    const totalCreatedCampaigns = campaigns.length;

    const activeCampaignIds = campaigns
      .filter((c) => Number(c.isActive) === 1)
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    // 3) Total hired influencers from ACTIVE campaigns (distinct)
    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length > 0) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            ...brandFilter("brandId", brandObjectId),
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
      { $match: brandFilter("brandId", brandObjectId) },
      { $unwind: "$milestoneHistory" },
      { $group: { _id: "$milestoneHistory.influencerId" } },
      { $count: "total" },
    ]);
    const totalMilestoneInfluencers = milestoneAgg?.[0]?.total || 0;

    // 5) Budget remaining (brand wallet)
    const milestoneDoc = await Milestone.findOne(brandFilter("brandId", brandObjectId), "walletBalance").lean();
    const budgetRemaining = Number(milestoneDoc?.walletBalance ?? 0);

    return res.status(200).json({
      brandId: brand._id.toString(),
      brandName: brand.brandName || brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalMilestoneInfluencers,
      budgetRemaining,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(err?.status || 500).json({ error: err?.message || "Server error" });
  }
};

/**
 * Influencer dashboard:
 * - Requires req.user.influencerId
 */
exports.getDashboardInf = async (req, res) => {
  try {
    const { influencerId } = req.user || {};
    if (!influencerId) return res.status(403).json({ message: "Forbidden" });

    const now = new Date();

    const pendingApprovals = await Contract.countDocuments(pendingContractFilter({ influencerId }));

    const acceptedContracts = await Contract.find(acceptedContractFilter({ influencerId }), "campaignId").lean();
    const acceptedCampaignIds = acceptedContracts.map((c) => String(c.campaignId || "")).filter(Boolean);

    const activeCampaigns = acceptedCampaignIds.length
      ? await Campaign.countDocuments({
        campaignsId: { $in: acceptedCampaignIds },
        "timeline.startDate": { $lte: now },
        $or: [{ "timeline.endDate": { $exists: false } }, { "timeline.endDate": null }, { "timeline.endDate": { $gte: now } }],
      })
      : 0;

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

    return res.status(200).json({
      influencerId,
      activeCampaigns,
      pendingApprovals,
      totalEarnings: releasedAgg?.total || 0,
      upcomingPayouts: upcomingAgg?.total || 0,
    });
  } catch (err) {
    console.error("Error in getDashboardInf:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandDashboardHome = async (req, res) => {
  try {
    const brandIdRaw = req.body?.brandId || req.user?.brandId;
    if (!brandIdRaw) {
      return res.status(400).json({ error: "brandId is required" });
    }

    const brandObjectId = toObjectIdStrict(brandIdRaw, "brandId");

    // 1) Brand
    const brand = await Brand.findById(brandObjectId, "name brandName").lean();
    if (!brand) {
      return res.status(404).json({ error: "Brand not found" });
    }

    // 2) All campaigns (non-draft)
    const allCampaigns = await Campaign.find(
      { ...brandFilter("brandId", brandObjectId), isDraft: { $ne: 1 } },
      `
        _id
        campaignTitle
        campaignGoals
        campaignBudget
        budget
        status
        publishStatus
        campaignStatus
        isActive
        createdAt
        numberOfInfluencers
        platformSelection
      `
    )
      .sort({ createdAt: -1 })
      .lean();

    const totalCreatedCampaigns = allCampaigns.length;

    const campaignIds = allCampaigns
      .map((c) => String(c._id || ""))
      .filter(Boolean);

    // 2.1) Resolve campaign goal names
    const goalIds = [
      ...new Set(
        allCampaigns
          .flatMap((c) => (Array.isArray(c.campaignGoals) ? c.campaignGoals : []))
          .map((id) => String(id))
          .filter(Boolean)
      ),
    ];

    let goalMap = new Map();
    if (goalIds.length) {
      const goals = await ProductServiceGoalModel.find(
        { _id: { $in: goalIds.map((id) => new mongoose.Types.ObjectId(id)) } },
        "_id goal"
      ).lean();

      goalMap = new Map(goals.map((g) => [String(g._id), g.goal]));
    }

    // 3) Accepted contracts -> latest per campaign
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ ...brandFilter("brandId", brandObjectId) }),
      "campaignId contractId influencerId lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const contractByCampaign = new Map();
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

    // 4) Applied influencers per campaign + total
    const appliedCountMap = new Map();
    let totalAppliedInfluencers = 0;

    if (campaignIds.length) {
      const agg = await ApplyCampaign.aggregate([
        { $match: { campaignId: { $in: campaignIds } } },
        { $unwind: "$applicants" },
        {
          $group: {
            _id: {
              campaignId: "$campaignId",
              influencerId: "$applicants.influencerId",
            },
          },
        },
        {
          $group: {
            _id: "$_id.campaignId",
            appliedInfluencersCount: { $sum: 1 },
          },
        },
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
      const id = String(camp._id || "");
      return id && !acceptedCampaignIds.has(id);
    });

    const showAll = acceptedCount === 0 || anyUnaccepted;
    const campaignsMode = showAll ? "all" : "accepted";

    const baseList = showAll
      ? allCampaigns
      : allCampaigns.filter((c) => acceptedCampaignIds.has(String(c._id || "")));

    const campaigns = baseList.map((c) => {
      const id = String(c._id || "");
      const meta = contractByCampaign.get(id) || {};

      const goalNames = (Array.isArray(c.campaignGoals) ? c.campaignGoals : [])
        .map((gid) => goalMap.get(String(gid)))
        .filter(Boolean);

      return {
        // campaignId: id,
        id, // optional

        campaignTitle: c.campaignTitle || "",
        productOrServiceName: c.campaignTitle || "",

        goals: goalNames,
        goal: goalNames[0] || "",

        campaignBudget: Number(c.campaignBudget || 0),
        budget: Number(c.campaignBudget || c.budget || 0),

        status: c.status || "",
        publishStatus: c.publishStatus || "",
        campaignStatus: c.campaignStatus || "",

        isActive: Number(c.isActive || 0),
        createdAt: c.createdAt || null,

        numberOfInfluencers: Number(c.numberOfInfluencers || 0),
        platformSelection: Array.isArray(c.platformSelection) ? c.platformSelection : [],

        hasAcceptedInfluencer: acceptedCampaignIds.has(id),
        influencerId: meta.influencerId ?? null,
        contractId: meta.contractId ?? null,

        appliedInfluencersCount: appliedCountMap.get(id) || 0,
      };
    });

    // 6) Total hired influencers from ACTIVE campaigns only
    const activeCampaignIds = allCampaigns
      .filter(
        (c) =>
          Number(c.isActive) === 1 &&
          c.status !== "draft" &&
          c.status !== "archived"
      )
      .map((c) => String(c._id || ""))
      .filter(Boolean);

    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            ...brandFilter("brandId", brandObjectId),
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);

      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 7) Budget remaining
    const milestone = await Milestone.findOne(
      brandFilter("brandId", brandObjectId),
      "walletBalance"
    ).lean();

    const budgetRemaining = Number(milestone?.walletBalance ?? 0);

    return res.status(200).json({
      brandId: String(brand._id),
      brandName: brand.brandName || brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalAppliedInfluencers,
      budgetRemaining,
      campaignsMode,
      campaigns,
    });
  } catch (err) {
    console.error("getBrandDashboardHome error:", err);
    return res
      .status(err?.status || 500)
      .json({ error: err?.message || "Server error" });
  }
};