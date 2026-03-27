const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Admin = require("../models/admin");
const { AdminModel, ROLES } = require("../models/master");
const Brand = require("../models/brand");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Campaign = require("../models/campaign");
const Milestone = require("../models/milestone");
const Modash = require("../models/modash");
const Payment = require("../models/payment");
const MissingEmail = require("../models/MissingEmail");
const Invitation = require("../models/NewInvitations");
const SubscriptionPlan = require("../models/subscription");
const PortalSettings = require("../models/portalSettings");
const BrandAssigned = require("../models/brandAssigned");

const { _sendCampaignInvitationInternal } = require("../controllers/emailController");
const subscriptionHelper = require("../utils/subscriptionHelper");

const ASSIGNEE_MODEL = AdminModel || Admin;
const FULLY_MANAGED_PLAN_ID = "e5cb75da-6d0d-481b-b202-69b9cf864940";
const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

void PortalSettings;

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeSortOrder(value, fallback = "desc") {
  return String(value || fallback).toLowerCase() === "asc" ? "asc" : "desc";
}

function safeRegex(value = "") {
  const q = String(value || "").trim();
  if (!q) return null;
  return new RegExp(escapeRegex(q), "i");
}

function normalizeHandle(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return withAt.toLowerCase();
}

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildSubscriptionFromPlan(plan, options = {}) {
  const now = new Date();

  const expiresAt = subscriptionHelper.computeExpiry(plan, {
    billingCycle: options.billingCycle || "monthly",
    durationDays: options.durationDays,
    durationMinutes: options.durationMinutes,
    durationMins: options.durationMins,
    expiresAt: options.expiresAt,
  });

  const featureSnapshot = (plan.features || []).map((feature) => ({
    key: feature.key,
    limit: featureValueToLimit(feature.value),
    used: 0,
  }));

  return {
    planId: plan.planId,
    planName: plan.name,
    startedAt: now,
    expiresAt,
    features: featureSnapshot,
    billingCycle: options.billingCycle || "monthly",
  };
}

function isExpiredDate(value) {
  if (!value) return false;
  const dt = new Date(value);
  return !Number.isNaN(dt.getTime()) && dt < new Date();
}

function isFullyManagedBrandDoc(doc = {}) {
  const subscription = doc.subscription || {};
  const planId = String(subscription.planId || "").trim();
  const planName = String(subscription.planName || "").toLowerCase().trim();
  const features = Array.isArray(subscription.features) ? subscription.features : [];

  if (planId === FULLY_MANAGED_PLAN_ID) return true;
  if (planName.includes("fully managed") || planName.includes("full managed")) return true;

  return features.some((feature) =>
    [
      "creator_sourcing_and_outreach",
      "shortlist_delivered",
      "negotiation_and_followups",
    ].includes(String(feature?.key || ""))
  );
}

function getStatusFromSubscription(doc = {}) {
  const subscription = doc.subscription || {};
  if (subscription.status) return subscription.status;
  return doc.subscriptionExpired || isExpiredDate(subscription.expiresAt) ? "expired" : "active";
}

function getBrandFieldValue(brand, field) {
  switch (field) {
    case "name":
      return brand.name || brand.brandName || "";
    case "email":
      return brand.email || "";
    case "phone":
      return `${brand.callingcode || ""} ${brand.phone || ""}`.trim();
    case "planName":
      return brand.planName || brand.subscription?.planName || "";
    case "createdAt":
      return brand.createdAt || "";
    case "expiresAt":
      return brand.expiresAt || brand.subscription?.expiresAt || "";
    case "status":
      return brand.status || getStatusFromSubscription(brand) || "";
    case "assignedRh":
    case "assignedRm":
      return brand.assignedRh || brand.assignedRm || "";
    case "assignedBme":
    case "assignedBm":
      return brand.assignedBme || brand.assignedBm || "";
    case "assignedIme":
    case "assignedIm":
      return brand.assignedIme || brand.assignedIm || "";
    default:
      return brand?.[field] || "";
  }
}

function compareBrandRows(a, b, field, dir) {
  const dateFields = new Set(["createdAt", "expiresAt"]);
  const av = getBrandFieldValue(a, field);
  const bv = getBrandFieldValue(b, field);

  if (dateFields.has(field)) {
    const at = av ? new Date(av).getTime() : 0;
    const bt = bv ? new Date(bv).getTime() : 0;
    return (at - bt) * dir;
  }

  return String(av).localeCompare(String(bv), undefined, {
    numeric: true,
    sensitivity: "base",
  }) * dir;
}

async function findCampaignByAnyId(campaignId) {
  const id = String(campaignId || "").trim();
  if (!id) return null;

  if (isObjectId(id)) {
    const byMongoId = await Campaign.findById(id).lean();
    if (byMongoId) return byMongoId;
  }

  return Campaign.findOne({ campaignsId: id }).lean();
}

async function findModashByUserId(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  if (isObjectId(id)) {
    const byId = await Modash.findById(id).lean();
    if (byId) return byId;
  }

  return Modash.findOne({
    $or: [
      { userId: id },
      { modashUserId: id },
      { profileId: id },
      { providerUserId: id },
      { platformUserId: id },
      { "user.userId": id },
      { "profile.userId": id },
    ],
  }).lean();
}

function extractHandleFromModash(modashDoc) {
  const candidates = [
    modashDoc?.handle,
    modashDoc?.username,
    modashDoc?.userName,
    modashDoc?.providerUsername,
    modashDoc?.user?.username,
    modashDoc?.profile?.username,
    modashDoc?.profile?.handle,
  ].filter(Boolean);

  if (!candidates.length) return null;
  return normalizeHandle(candidates[0]);
}

async function enrichBrandsWithAssignments(brandDocs = []) {
  if (!Array.isArray(brandDocs) || brandDocs.length === 0) return [];

  const brandIds = brandDocs
    .map((brand) => brand?._id)
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));

  if (!brandIds.length) return brandDocs;

  const activeAssignments = await BrandAssigned.find({
    brandId: { $in: brandIds },
    status: "active",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  const assignmentMap = new Map();
  for (const assignment of activeAssignments) {
    const key = String(assignment.brandId);
    if (!assignmentMap.has(key)) assignmentMap.set(key, assignment);
  }

  const missingIds = brandIds.filter((id) => !assignmentMap.has(String(id)));
  if (missingIds.length) {
    const fallbacks = await BrandAssigned.find({
      brandId: { $in: missingIds },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    for (const assignment of fallbacks) {
      const key = String(assignment.brandId);
      if (!assignmentMap.has(key)) assignmentMap.set(key, assignment);
    }
  }

  const assigneeIds = [...assignmentMap.values()]
    .flatMap((assignment) => [assignment?.RHId, assignment?.bdmId, assignment?.idmId])
    .filter(Boolean)
    .map((id) => String(id));

  const uniqueAssigneeIds = [...new Set(assigneeIds)]
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));

  const assignees = uniqueAssigneeIds.length
    ? await ASSIGNEE_MODEL.find({ _id: { $in: uniqueAssigneeIds } })
      .select("_id name email")
      .lean()
    : [];

  const assigneeMap = {};
  assignees.forEach((assignee) => {
    assigneeMap[String(assignee._id)] = assignee.name || assignee.email || "";
  });

  return brandDocs.map((brand) => {
    const assignment = assignmentMap.get(String(brand._id));
    const subscription = brand.subscription || {};
    const expiresAt = subscription.expiresAt || null;
    const subscriptionExpired = Boolean(brand.subscriptionExpired) || isExpiredDate(expiresAt);
    const status = subscription.status || (subscriptionExpired ? "expired" : "active");

    const assignedRh = assignment?.RHId ? assigneeMap[String(assignment.RHId)] || "" : "";
    const assignedBme = assignment?.bdmId ? assigneeMap[String(assignment.bdmId)] || "" : "";
    const assignedIme = assignment?.idmId ? assigneeMap[String(assignment.idmId)] || "" : "";

    return {
      ...brand,
      planName: subscription.planName || "free",
      expiresAt,
      status,
      subscriptionExpired,
      assignedRh,
      assignedBme,
      assignedIme,
      assignedRm: assignedRh,
      assignedBm: assignedBme,
      assignedIm: assignedIme,
      fullyManagedSubscription: isFullyManagedBrandDoc(brand),
      assignmentId: assignment?._id || null,
      assignmentStatus: assignment?.status || null,
      RHId: assignment?.RHId || null,
      bdmId: assignment?.bdmId || null,
      idmId: assignment?.idmId || null,
    };
  });
}

async function getScopedCampaignBrandKeysForAdmin(actor = {}) {
  const scopedBrandObjectIds = await getScopedBrandIdsForAdmin(actor);

  // super admin => no restriction
  if (scopedBrandObjectIds === null) return null;

  // BME / IME / RH with nothing assigned => no campaigns
  if (!Array.isArray(scopedBrandObjectIds) || !scopedBrandObjectIds.length) {
    return [];
  }

  const brands = await Brand.find({
    _id: { $in: scopedBrandObjectIds },
  })
    .select("_id brandId")
    .lean();

  const keys = new Set();

  for (const brand of brands) {
    if (brand?._id) keys.add(String(brand._id));
    if (brand?.brandId) keys.add(String(brand.brandId));
  }

  return [...keys];
}

function getCampaignSortField(sortBy) {
  const map = {
    campaignTitle: "campaignTitle",
    name: "campaignTitle",
    goal: "goal",
    startDate: "timeline.startDate",
    endDate: "timeline.endDate",
    budget: "budget",
    applicantCount: "applicantCount",
    isActive: "isActive",
    createdAt: "createdAt",
  };

  return map[sortBy] || "createdAt";
}

function buildCampaignBaseFilter({ search, statusFlag, brandKeys, requestedBrandId }) {
  const filter = {};

  if (Array.isArray(brandKeys)) {
    if (!brandKeys.length) {
      filter.brandId = { $in: [] };
      return filter;
    }

    filter.brandId = { $in: brandKeys };
  }

  if (requestedBrandId) {
    const requested = String(requestedBrandId).trim();

    if (filter.brandId?.$in) {
      if (!filter.brandId.$in.includes(requested)) {
        filter.brandId = { $in: [] };
        return filter;
      }
      filter.brandId = requested;
    } else {
      filter.brandId = requested;
    }
  }

  if (statusFlag === 1) filter.isActive = 1;
  if (statusFlag === 2) filter.isActive = 0;

  const re = safeRegex(search);
  if (re) {
    filter.$or = [
      { campaignTitle: re },
      { productOrServiceName: re },
      { brandName: re },
      { description: re },
      { goal: re },
    ];
  }

  return filter;
}

function toCampaignSummary(doc = {}) {
  return {
    _id: doc._id,
    brandId: doc.brandId || "",
    campaignId: doc.campaignsId || String(doc._id || ""),
    name: doc.campaignTitle || doc.productOrServiceName || "—",
    startDate: doc.timeline?.startDate || null,
    endDate: doc.timeline?.endDate || null,
    budget: Number(doc.budget || 0),
    goal: doc.goal || "",
    applicantCount: Number(doc.applicantCount || 0),
    isActive: Number(doc.isActive || 0),
    isDraft: Number(doc.isDraft || 0),
    campaignStatus: doc.campaignStatus || "",
  };
}

exports.adminAssignBrandPlan = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const planId = String(req.body?.planId || "").trim();
    const billingCycle = String(req.body?.billingCycle || "monthly").trim();

    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!brandId || !planId) {
      return res.status(400).json({ message: "brandId and planId required" });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Brand",
      status: "active",
    }).lean();

    if (!plan) {
      return res.status(404).json({ message: "Brand plan not found/archived" });
    }

    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle,
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    const updated = await Brand.findOneAndUpdate(
      { brandId },
      { $set: { subscription, subscriptionExpired: false } },
      { new: true }
    )
      .select("brandId name email subscription subscriptionExpired")
      .lean();

    if (!updated) {
      return res.status(404).json({ message: "Brand not found" });
    }

    return res.json({ status: "success", brand: updated });
  } catch (error) {
    console.error("adminAssignBrandPlan error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminAssignInfluencerPlan = async (req, res) => {
  try {
    const influencerId = String(req.body?.influencerId || "").trim();
    const planId = String(req.body?.planId || "").trim();

    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!influencerId || !planId) {
      return res.status(400).json({ message: "influencerId and planId required" });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Influencer",
      status: "active",
    }).lean();

    if (!plan) {
      return res.status(404).json({ message: "Influencer plan not found/archived" });
    }

    if (!isObjectId(influencerId)) {
      return res.status(400).json({ message: "Valid influencer _id required" });
    }

    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle: "monthly",
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    const updated = await Influencer.findByIdAndUpdate(
      influencerId,
      { $set: { subscription, subscriptionExpired: false } },
      { new: true }
    )
      .select("_id name email subscription subscriptionExpired")
      .lean();

    if (!updated) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    return res.json({ status: "success", influencer: updated });
  } catch (error) {
    console.error("adminAssignInfluencerPlan error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await admin.correctPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { adminId: admin.adminId, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      message: "Login successful",
      token,
      admin: {
        adminId: admin.adminId,
        email: admin.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(403).json({ message: "Token required" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(403).json({ message: "Token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    req.admin = decoded;
    return next();
  });
};

async function resolveActorFromMaster(actor = {}) {
  let adminId = String(actor?.adminId || actor?._id || "").trim();
  let email = String(actor?.email || "").trim().toLowerCase();
  let role = String(actor?.role || "").trim().toLowerCase();

  const validRoles = new Set(Object.values(ROLES));

  const mustResolve =
    !adminId ||
    !isObjectId(adminId) ||
    !role ||
    !validRoles.has(role);

  if (!mustResolve) {
    return { adminId, email, role };
  }

  const or = [];
  if (isObjectId(adminId)) or.push({ _id: toObjectId(adminId) });
  if (email) or.push({ email });

  if (!or.length) {
    return { adminId: "", email, role: "" };
  }

  const masterAdmin = await AdminModel.findOne({ $or: or })
    .select("_id email role parentAdmin rootAdmin")
    .lean();

  if (!masterAdmin) {
    return { adminId: "", email, role: "" };
  }

  return {
    adminId: String(masterAdmin._id),
    email: String(masterAdmin.email || "").toLowerCase(),
    role: String(masterAdmin.role || "").trim().toLowerCase(),
  };
}

async function getScopedBrandIdsForAdmin(actor = {}) {
  const role = String(actor?.role || "").trim().toLowerCase();
  const adminId = String(actor?.adminId || actor?._id || "").trim();

  if (!adminId) return [];

  // both super_admin and revenue_head can see all brands
  if (role === ROLES.SUPER_ADMIN || role === ROLES.REVENUE_HEAD) {
    return null;
  }

  const roleToField = {
    [ROLES.BME]: "bdmId",
    [ROLES.IME]: "idmId",
  };

  const assignmentField = roleToField[role];

  if (!assignmentField) {
    return [];
  }

  const assigneeFilters = [{ [assignmentField]: adminId }];

  if (isObjectId(adminId)) {
    assigneeFilters.push({ [assignmentField]: toObjectId(adminId) });
  }

  const assignments = await BrandAssigned.find({
    status: "active",
    $or: assigneeFilters,
  })
    .select("brandId")
    .lean();

  return assignments
    .map((item) => String(item.brandId || ""))
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));
}

exports.getAllBrands = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const dir = sortOrder === "asc" ? 1 : -1;

    const actor = req.admin || {};
    const scopedBrandIds = await getScopedBrandIdsForAdmin(actor);

    const brandQuery = {};

    if (Array.isArray(scopedBrandIds)) {
      if (!scopedBrandIds.length) {
        return res.status(200).json({
          page,
          limit,
          total: 0,
          totalPages: 1,
          sortBy,
          sortOrder,
          brands: [],
        });
      }

      brandQuery._id = { $in: scopedBrandIds };
    }

    const rawBrands = await Brand.find(brandQuery)
      .select("-password -__v")
      .lean();

    const enrichedBrands = await enrichBrandsWithAssignments(rawBrands);
    const re = safeRegex(search);

    const filtered = re
      ? enrichedBrands.filter((brand) =>
        [
          brand.name,
          brand.brandName,
          brand.email,
          brand.phone,
          brand.callingcode,
          brand.companySize,
          brand.industry,
          brand.planName,
          brand.status,
          brand.assignedRh,
          brand.assignedRm,
          brand.assignedBme,
          brand.assignedBm,
          brand.assignedIme,
          brand.assignedIm,
        ].some((value) => re.test(String(value || "")))
      )
      : enrichedBrands;

    const allowedSortFields = new Set([
      "name",
      "email",
      "phone",
      "planName",
      "createdAt",
      "expiresAt",
      "status",
      "assignedRh",
      "assignedRm",
      "assignedBme",
      "assignedBm",
      "assignedIme",
      "assignedIm",
    ]);

    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";

    const sorted = [...filtered].sort((a, b) => {
      const primary = compareBrandRows(a, b, field, dir);
      if (primary !== 0) return primary;
      return compareBrandRows(a, b, "createdAt", -1);
    });

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const brands = sorted.slice((page - 1) * limit, page * limit);

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages,
      sortBy: field,
      sortOrder,
      brands,
    });
  } catch (error) {
    console.error("Error in getAllBrands:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getList = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "name").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "asc");

    const filter = {};
    const re = safeRegex(search);

    if (re) {
      filter.$or = [
        { name: re },
        { email: re },
        { countryName: re },
        { proxyEmail: re },
      ];
    }

    const total = await Influencer.countDocuments(filter);
    const allowedSortFields = new Set(["name", "email", "countryName", "createdAt"]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "name";
    const dir = sortOrder === "desc" ? -1 : 1;

    const influencers = await Influencer.find(filter)
      .select("-password -__v")
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      influencers,
    });
  } catch (error) {
    console.error("Error fetching influencers:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAllCampaigns = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.type, 10) || 0;
    const brandId = String(req.body?.brandId || "").trim();

    const actor = req.admin || {};
    const visibleBrandKeys = await getScopedCampaignBrandKeysForAdmin(actor);

    const filter = buildCampaignBaseFilter({
      search,
      statusFlag,
      brandKeys: visibleBrandKeys,
      requestedBrandId: brandId,
    });

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const total = await Campaign.countDocuments(filter);

    const campaigns = await Campaign.find(filter)
      .select("-__v")
      .sort({ [field]: dir, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      status: statusFlag,
      sortBy,
      sortOrder,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getAllCampaigns:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandById = async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();

    if (!id) {
      return res.status(400).json({ message: "Query parameter id is required." });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({ message: "Invalid brand _id." });
    }

    const brandDoc = await Brand.findById(id)
      .select("-password -__v")
      .lean();

    if (!brandDoc) {
      return res.status(404).json({ message: "Brand not found." });
    }

    const [enrichedBrand] = await enrichBrandsWithAssignments([brandDoc]);
    const milestoneDoc = await Milestone.findOne({ brandId: brandDoc.brandId }).lean();
    const walletBalance = milestoneDoc ? milestoneDoc.walletBalance : 0;

    return res.status(200).json({
      ...enrichedBrand,
      walletBalance,
    });
  } catch (error) {
    console.error("Error in getBrandById:", error);
    return res.status(500).json({ message: "Internal server error while fetching brand." });
  }
};

exports.getByInfluencerId = async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();

    if (!id) {
      return res.status(400).json({ message: "Query parameter id is required." });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({ message: "Invalid influencer _id." });
    }

    const influencer = await Influencer.findById(id)
      .select("-password -__v")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const modashProfiles = await Modash.find(
      {
        $or: [
          { influencer: influencer._id },
          { influencerId: String(influencer._id) },
        ],
      },
      "-__v -providerRaw"
    ).lean();

    return res.status(200).json({
      influencer,
      modash: modashProfiles,
    });
  } catch (error) {
    console.error("Error fetching influencer & Modash by ID:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCampaignById = async (req, res) => {
  try {
    const id = String(
      req.query?.id || req.body?.campaignId || req.body?._id || ""
    ).trim();

    if (!id) {
      return res.status(400).json({
        message: "Query parameter id or body campaignId is required.",
      });
    }

    const actor = req.admin || {};
    const visibleBrandKeys = await getScopedCampaignBrandKeysForAdmin(actor);

    const filter = {
      $or: [{ campaignsId: id }],
    };

    if (mongoose.Types.ObjectId.isValid(id)) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(id) });
    }

    if (Array.isArray(visibleBrandKeys)) {
      if (!visibleBrandKeys.length) {
        return res.status(404).json({ message: "Campaign not found." });
      }
      filter.brandId = { $in: visibleBrandKeys };
    }

    const campaign = await Campaign.findOne(filter).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found." });
    }

    return res.json(campaign);
  } catch (error) {
    console.error("Error in getCampaignById:", error);
    return res.status(500).json({
      message: "Internal server error while fetching campaign.",
    });
  }
};

exports.getCampaignsByBrandId = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.status, 10) || 0;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required in the request body" });
    }

    const filter = { brandId };

    if (statusFlag === 1) filter.isActive = 1;
    if (statusFlag === 2) filter.isActive = 0;

    if (search) {
      const re = safeRegex(search);
      const numericSearch = Number(search);

      const orClauses = [
        { brandName: re },
        { productOrServiceName: re },
        { description: re },
        { "targetAudience.location": re },
        { interestName: re },
        { goal: re },
        { creativeBriefText: re },
        { additionalNotes: re },
        { images: re },
        { creativeBrief: re },
      ];

      if (!Number.isNaN(numericSearch)) {
        orClauses.push(
          { "targetAudience.age.MinAge": numericSearch },
          { "targetAudience.age.MaxAge": numericSearch },
          { budget: numericSearch },
          { applicantCount: numericSearch }
        );
      }

      filter.$or = orClauses;
    }

    const total = await Campaign.countDocuments(filter);
    const allowedSortFields = new Set([
      "brandName",
      "productOrServiceName",
      "createdAt",
      "timeline.startDate",
      "timeline.endDate",
      "budget",
    ]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const campaigns = await Campaign.find(filter)
      .select("-__v")
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      status: statusFlag,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getCampaignsByBrandId:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminGetInfluencerById = async (req, res) => {
  try {
    const id = String(req.body?.id || req.body?.influencerId || "").trim();

    if (!id) {
      return res.status(400).json({ message: 'Body parameter "id" is required.' });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({ message: "Invalid influencer _id." });
    }

    const influencer = await Influencer.findById(id)
      .select("-password -__v")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    return res.status(200).json({ influencer });
  } catch (error) {
    console.error("Error in adminGetInfluencerById:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminGetInfluencerList = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");

    const filter = {};
    const re = safeRegex(search);

    if (re) {
      filter.$or = [
        { name: re },
        { email: re },
        { countryName: re },
        { proxyEmail: re },
        { "subscription.planName": re },
      ];
    }

    const total = await Influencer.countDocuments(filter);
    const allowedSortFields = new Set([
      "name",
      "email",
      "countryName",
      "createdAt",
      "planName",
      "expiresAt",
    ]);

    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const sortObj = {};
    if (field === "planName") sortObj["subscription.planName"] = dir;
    else if (field === "expiresAt") sortObj["subscription.expiresAt"] = dir;
    else sortObj[field] = dir;
    sortObj.createdAt = -1;

    const docs = await Influencer.find(filter)
      .select("_id name email countryName proxyEmail subscription.planName subscription.expiresAt subscriptionExpired createdAt")
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const influencers = docs.map((doc) => {
      const planName = doc.subscription?.planName || "free";
      const expiresAt = doc.subscription?.expiresAt || null;
      const subscriptionExpired = Boolean(doc.subscriptionExpired) || isExpiredDate(expiresAt);

      return {
        _id: doc._id,
        name: doc.name || "",
        email: doc.email || "",
        countryName: doc.countryName || "",
        proxyEmail: doc.proxyEmail || "",
        planName,
        expiresAt,
        subscriptionExpired,
      };
    });

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy: field,
      sortOrder,
      influencers,
    });
  } catch (error) {
    console.error("Error in adminGetInfluencerList:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminAddYouTubeEmail = async (req, res) => {
  try {
    const rawHandle = String(req.body?.handle || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const platform = "youtube";

    if (!rawHandle || !email) {
      return res.status(400).json({
        status: "error",
        message: "handle and email are required",
      });
    }

    if (!EMAIL_RX.test(email)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid email address",
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid handle format",
      });
    }

    let missingEmailDoc = await MissingEmail.findOne({ handle, platform });
    const isExisting = Boolean(missingEmailDoc);

    if (!missingEmailDoc) {
      missingEmailDoc = await MissingEmail.create({
        handle,
        platform,
        email,
        createdByAdminId: req.admin?.adminId || req.user?.adminId || null,
      });
    } else {
      missingEmailDoc.email = email;
      await missingEmailDoc.save();
    }

    try {
      await Invitation.updateMany(
        {
          handle,
          platform,
          $or: [
            { missingEmailId: { $exists: false } },
            { missingEmailId: null },
            { missingEmailId: "" },
          ],
        },
        { $set: { missingEmailId: missingEmailDoc.missingEmailId } }
      );
    } catch (attachError) {
      console.error("adminAddYouTubeEmail attach failed:", attachError);
    }

    let autoInvitesSent = 0;

    if (!isExisting) {
      try {
        const invitations = await Invitation.find({ handle, platform }).lean();

        for (const invitation of invitations) {
          if (!invitation.brandId) continue;

          try {
            await _sendCampaignInvitationInternal({
              brandId: invitation.brandId,
              campaignId: invitation.campaignId || null,
              invitationId: invitation.invitationId,
              influencerId: null,
              campaignLink: null,
              compensation: null,
              deliverables: null,
              additionalNotes: null,
              subject: null,
              body: null,
            });
            autoInvitesSent += 1;
          } catch (sendError) {
            console.error("adminAddYouTubeEmail invitation send failed:", sendError);
          }
        }
      } catch (listError) {
        console.error("adminAddYouTubeEmail invitation list failed:", listError);
      }
    }

    return res.json({
      status: isExisting ? "exists" : "saved",
      message: isExisting ? "Email updated for existing handle." : "Email saved successfully.",
      data: {
        missingEmailId: missingEmailDoc.missingEmailId,
        email: missingEmailDoc.email,
        handle: missingEmailDoc.handle,
        platform: missingEmailDoc.platform,
        createdAt: missingEmailDoc.createdAt,
        updatedAt: missingEmailDoc.updatedAt,
        autoInvitesSent,
      },
    });
  } catch (error) {
    console.error("Error in adminAddYouTubeEmail:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.listMissingEmail = async (req, res) => {
  try {
    const body = req.body || {};
    const page = parsePositiveInt(body.page, 1, { min: 1, max: 100000 });
    const limit = parsePositiveInt(body.limit, 50, { min: 1, max: 200 });

    const rawSearch = typeof body.search === "string" ? body.search.trim() : "";
    const rawEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const rawHandle = typeof body.handle === "string" ? body.handle.trim() : "";
    const rawCreatedByAdminId = typeof body.createdByAdminId === "string" ? body.createdByAdminId.trim() : "";

    const query = {};

    if (rawEmail) query.email = rawEmail;

    if (rawHandle) {
      const handle = normalizeHandle(rawHandle);
      if (!HANDLE_RX.test(handle)) {
        return res.status(400).json({ status: "error", message: "Invalid handle format in filter" });
      }
      query.handle = handle;
    }

    if (rawCreatedByAdminId) {
      query.createdByAdminId = rawCreatedByAdminId;
    }

    const [total, docs] = await Promise.all([
      MissingEmail.countDocuments(query),
      MissingEmail.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          _id: 0,
          missingEmailId: 1,
          email: 1,
          handle: 1,
          platform: 1,
          youtube: 1,
          createdByAdminId: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
    ]);

    let data = docs;
    if (rawSearch) {
      const re = safeRegex(rawSearch);
      data = docs.filter((row) =>
        re.test(row.email || "") ||
        re.test(row.handle || "") ||
        re.test(row.missingEmailId || "") ||
        re.test(row.createdByAdminId || "")
      );
    }

    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data,
    });
  } catch (error) {
    console.error("Error in listMissingEmail:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.updateMissingEmail = async (req, res) => {
  try {
    const missingEmailId = String(req.body?.missingEmailId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!missingEmailId) {
      return res.status(400).json({ status: "error", message: "missingEmailId is required" });
    }

    if (!email) {
      return res.status(400).json({ status: "error", message: "email is required" });
    }

    if (!EMAIL_RX.test(email)) {
      return res.status(400).json({ status: "error", message: "Invalid email address" });
    }

    const doc = await MissingEmail.findOne({ missingEmailId });
    if (!doc) {
      return res.status(404).json({ status: "error", message: "MissingEmail record not found" });
    }

    doc.email = email;
    await doc.save();

    let autoInvitesSent = 0;

    try {
      await Invitation.updateMany(
        {
          handle: doc.handle,
          platform: doc.platform,
          $or: [
            { missingEmailId: { $exists: false } },
            { missingEmailId: null },
            { missingEmailId: "" },
          ],
        },
        { $set: { missingEmailId: doc.missingEmailId } }
      );
    } catch (attachError) {
      console.error("updateMissingEmail attach failed:", attachError);
    }

    try {
      const invitations = await Invitation.find({
        handle: doc.handle,
        platform: doc.platform,
      }).lean();

      for (const invitation of invitations) {
        if (!invitation.brandId) continue;

        try {
          await _sendCampaignInvitationInternal({
            brandId: invitation.brandId,
            campaignId: invitation.campaignId || null,
            invitationId: invitation.invitationId,
            influencerId: null,
            campaignLink: null,
            compensation: null,
            deliverables: null,
            additionalNotes: null,
            subject: null,
            body: null,
          });
          autoInvitesSent += 1;
        } catch (sendError) {
          console.error("updateMissingEmail invitation send failed:", sendError);
        }
      }
    } catch (listError) {
      console.error("updateMissingEmail invitation list failed:", listError);
    }

    return res.json({
      status: "success",
      message: "Email updated successfully.",
      data: {
        missingEmailId: doc.missingEmailId,
        email: doc.email,
        handle: doc.handle,
        platform: doc.platform,
        youtube: doc.youtube || null,
        createdByAdminId: doc.createdByAdminId || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        autoInvitesSent,
      },
    });
  } catch (error) {
    console.error("Error in updateMissingEmail:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.checkMissingEmailByHandle = async (req, res) => {
  try {
    const rawHandle = String(req.body?.handle || "").trim();
    const rawPlatform = String(req.body?.platform || "youtube").trim().toLowerCase();

    if (!rawHandle) {
      return res.status(400).json({ status: 0, message: "handle is required" });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 0,
        message: 'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    if (rawPlatform !== "youtube") {
      return res.status(400).json({
        status: 0,
        message: 'Invalid platform. MissingEmail only supports "youtube".',
      });
    }

    const doc = await MissingEmail.findOne({ handle, platform: rawPlatform }).lean();
    if (!doc) {
      return res.json({ status: 0, handle, email: null, platform: rawPlatform });
    }

    return res.json({
      status: 1,
      handle: doc.handle,
      email: doc.email,
      platform: doc.platform,
    });
  } catch (error) {
    console.error("Error in checkMissingEmailByHandle:", error);
    return res.status(500).json({
      status: 0,
      message: "Internal server error while checking missing email.",
    });
  }
};

exports.getAllPayments = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFilter = String(req.body?.status || "").trim();
    const roleFilter = String(req.body?.role || "").trim();

    const filter = {};

    if (statusFilter && statusFilter !== "all") {
      filter.status = statusFilter;
    }

    if (roleFilter && roleFilter !== "all") {
      filter.role = roleFilter;
    }

    if (search) {
      const re = safeRegex(search);
      filter.$or = [
        { orderId: re },
        { paymentId: re },
        { invoiceNumber: re },
        { invoiceEmailTo: re },
        { planName: re },
        { userId: re },
      ];
    }

    const total = await Payment.countDocuments(filter);
    const allowedSortFields = new Set(["amount", "createdAt", "paidAt", "status", "planName"]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const payments = await Payment.find(filter)
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const brandIds = [];
    const influencerIds = [];

    payments.forEach((payment) => {
      if (payment.role === "Brand" && payment.userId) brandIds.push(payment.userId);
      if (payment.role === "Influencer" && payment.userId) influencerIds.push(payment.userId);
    });

    const [brands, influencers] = await Promise.all([
      Brand.find({ brandId: { $in: brandIds } })
        .select("brandId name brandName email")
        .lean(),
      Influencer.find({
        _id: {
          $in: influencerIds.filter((id) => isObjectId(id)).map((id) => toObjectId(id)),
        },
      })
        .select("_id name email")
        .lean(),
    ]);

    const brandMap = {};
    brands.forEach((brand) => {
      brandMap[brand.brandId] = brand.name || brand.brandName || brand.email || "Unknown Brand";
    });

    const influencerMap = {};
    influencers.forEach((influencer) => {
      influencerMap[String(influencer._id)] = influencer.name || influencer.email || "Unknown Influencer";
    });

    const data = payments.map((payment) => {
      let userName = "Unknown";

      if (payment.role === "Brand") {
        userName = brandMap[payment.userId] || `Brand (${payment.userId})`;
      } else if (payment.role === "Influencer") {
        userName = influencerMap[payment.userId] || `Influencer (${payment.userId})`;
      }

      return {
        _id: payment._id,
        orderId: payment.orderId,
        paymentId: payment.paymentId || "N/A",
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        planName: payment.planName,
        role: payment.role,
        userId: payment.userId,
        userName,
        invoiceNumber: payment.invoiceNumber || "-",
        invoiceEmailTo: payment.invoiceEmailTo || "-",
        createdAt: payment.createdAt,
        paidAt: payment.paidAt,
      };
    });

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy: field,
      sortOrder,
      payments: data,
    });
  } catch (error) {
    console.error("Error in getAllPayments:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAllCampaignsLite = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.type, 10) || 0;
    const brandId = String(req.body?.brandId || "").trim();

    const actor = req.admin || {};
    const visibleBrandKeys = await getScopedCampaignBrandKeysForAdmin(actor);

    const filter = buildCampaignBaseFilter({
      search,
      statusFlag,
      brandKeys: visibleBrandKeys,
      requestedBrandId: brandId,
    });

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const total = await Campaign.countDocuments(filter);

    const rows = await Campaign.find(filter)
      .select(
        "_id brandId campaignsId campaignTitle productOrServiceName goal budget applicantCount isActive isDraft campaignStatus timeline.startDate timeline.endDate createdAt"
      )
      .sort({ [field]: dir, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const campaigns = rows.map(toCampaignSummary);

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      status: statusFlag,
      sortBy,
      sortOrder,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getAllCampaignsLite:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.fullyManagedBrandList = async (req, res) => {
  try {
    const rawBrands = await Brand.find({
      $or: [
        { "subscription.planId": FULLY_MANAGED_PLAN_ID },
        { "subscription.planName": /fully managed/i },
      ],
    })
      .select("-password -__v")
      .lean();

    const enrichedBrands = await enrichBrandsWithAssignments(rawBrands);
    const data = enrichedBrands.filter((brand) => brand.fullyManagedSubscription);

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("fullyManagedBrandList error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal error",
    });
  }
};

exports.assignBrand = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const RHId = req.body?.RHId;
    const bdmId = req.body?.bdmId;
    const idmId = req.body?.idmId;

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    if (!isObjectId(brandId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId",
      });
    }

    const wantsRH = RHId !== undefined && RHId !== null && String(RHId).trim() !== "";
    const wantsBDMOrIDM = bdmId !== undefined || idmId !== undefined;

    if (!wantsRH && !wantsBDMOrIDM) {
      return res.status(400).json({
        success: false,
        message: "Send RHId to assign RH OR send bdmId/idmId to assign BDM/IDM",
      });
    }

    const normalizedBrandId = toObjectId(brandId);

    if (wantsRH) {
      const set = {
        RHId: RHId || null,
        status: "active",
      };

      if (bdmId !== undefined) set.bdmId = bdmId || null;
      if (idmId !== undefined) set.idmId = idmId || null;

      let doc = await BrandAssigned.findOneAndUpdate(
        { brandId: normalizedBrandId, status: "active" },
        { $set: set },
        { new: true }
      ).exec();

      if (!doc) {
        doc = await BrandAssigned.findOneAndUpdate(
          { brandId: normalizedBrandId },
          { $set: set },
          { new: true, sort: { updatedAt: -1, createdAt: -1 } }
        ).exec();
      }

      if (!doc) {
        doc = await BrandAssigned.create({
          brandId: normalizedBrandId,
          RHId: RHId || null,
          bdmId: bdmId || null,
          idmId: idmId || null,
          status: "active",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Brand assignment saved successfully",
        data: doc,
      });
    }

    const set = {};
    if (bdmId !== undefined) set.bdmId = bdmId || null;
    if (idmId !== undefined) set.idmId = idmId || null;

    let updated = await BrandAssigned.findOneAndUpdate(
      {
        brandId: normalizedBrandId,
        status: "active",
        RHId: { $exists: true, $ne: null },
      },
      { $set: set },
      { new: true }
    ).exec();

    if (!updated) {
      updated = await BrandAssigned.findOneAndUpdate(
        {
          brandId: normalizedBrandId,
          RHId: { $exists: true, $ne: null },
        },
        { $set: { ...set, status: "active" } },
        { new: true, sort: { updatedAt: -1, createdAt: -1 } }
      ).exec();
    }

    if (!updated) {
      return res.status(400).json({
        success: false,
        message: "RH is not assigned for this brand. Assign RH first, then add BDM/IDM.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Brand assignment updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("assignBrand error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal error",
    });
  }
};

module.exports.findCampaignByAnyId = findCampaignByAnyId;
module.exports.findModashByUserId = findModashByUserId;
module.exports.extractHandleFromModash = extractHandleFromModash;
module.exports.enrichBrandsWithAssignments = enrichBrandsWithAssignments;
