const mongoose = require('mongoose');
const multer = require('multer');
const { uploadToGridFS } = require('../utils/gridfs');

const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Category = require('../models/categories');
const ApplyCampaign = require('../models/applyCampaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const SubscriptionPlan = require('../models/subscription');
const getFeature = require('../utils/getFeature');
const Milestone = require('../models/milestone');
const Country = require('../models/country');
const Modash = require('../models/modash');
const { CONTRACT_STATUS } = require("../constants/contract");
const Admin = require("../models/admin");

const { createAndEmit } = require('../utils/notifier');

// ===============================
//  Helpers & Normalizers
// ===============================
function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function sortLocations(arr = []) {
  return [...arr].sort((a, b) => String(a.countryId).localeCompare(String(b.countryId)));
}

function sortCategories(arr = []) {
  return [...arr].sort((a, b) => {
    const ak = `${a.categoryId}-${a.subcategoryId}`;
    const bk = `${b.categoryId}-${b.subcategoryId}`;
    return ak.localeCompare(bk);
  });
}

function normalizeForDiff(obj) {
  const out = { ...obj };
  if (out.targetAudience?.locations) {
    out.targetAudience = {
      ...out.targetAudience,
      locations: sortLocations(out.targetAudience.locations),
    };
  }
  if (out.categories) {
    out.categories = sortCategories(out.categories);
  }
  if (out.budget !== undefined) out.budget = Number(out.budget);
  if (out.influencerBudget !== undefined) out.influencerBudget = Number(out.influencerBudget);
  return out;
}

function diffObject(base, next) {
  if (Array.isArray(base) || Array.isArray(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }
  if (!isPlainObject(base) || !isPlainObject(next)) {
    return base === next ? undefined : next;
  }
  const patch = {};
  for (const key of Object.keys(next)) {
    const d = diffObject(base?.[key], next[key]);
    if (d !== undefined) patch[key] = d;
  }
  return Object.keys(patch).length ? patch : undefined;
}

function isAdminRequest(req) {
  const role = String(req.user?.role || req.user?.userType || "").toLowerCase();
  if (req.user?.brandId || role.includes("brand")) return false;
  if (role.includes("admin")) return true;
  if (req.user?.isAdmin === true) return true;
  if (req.user?.adminId && !req.user?.brandId) return true;

  if (req.body?.adminId || req.query?.adminId) return true;

  return false;
}

async function resolveActorFromPayload(req, fallbackBrandId = "") {
  const role = String(req.user?.role || req.user?.userType || "").toLowerCase();

  if (!req.user?.brandId && (role.includes("admin") || req.user?.isAdmin === true || req.user?.adminId)) {
    let adminKey = String(req.user?.adminId || req.user?._id || req.user?.id || "").trim();
    if (mongoose.Types.ObjectId.isValid(adminKey)) {
      const a = await Admin.findById(adminKey, "adminId").lean();
      if (a?.adminId) adminKey = String(a.adminId);
    } else {
      const a = await Admin.findOne({ adminId: adminKey }, "adminId").lean();
      if (a?.adminId) adminKey = String(a.adminId);
    }
    return { role: "admin", userId: adminKey };
  }

  const raw = req.body?.adminId;
  const adminId = raw == null ? "" : String(raw).trim();
  if (adminId) {
    const admin = await Admin.findOne({ adminId }, "adminId").lean();
    if (admin) return { role: "admin", userId: String(admin.adminId) };
  }

  return { role: "brand", userId: String(fallbackBrandId || "") };
}

function mapCampaignForInfluencer(c) {
  if (!c) return c;
  const brandBudget = toNum(c.budget, 0);
  const infBudget = toNum(c.influencerBudget, 0);
  return {
    ...c,
    budget: infBudget > 0 ? infBudget : brandBudget,
    brandBudget,
    influencerBudget: infBudget
  };
}

// ===============================
//  Notifications
// ===============================
async function notifyBrandDraftReady(campaign) {
  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.draft_review",
    title: "Review your new campaign draft",
    message: `Admin has drafted "${campaign.productOrServiceName}". Please review and confirm.`,
    entityType: "campaign",
    entityId: String(campaign.campaignsId),
    actionPath: { brand: `/brand/review-campaigns/view?id=${campaign.campaignsId}` },
  });
}

async function notifyAdminBrandConfirmed(campaign) {
  const admins = await Admin.find({}, "adminId").lean();
  const adminIds = admins.map((a) => String(a.adminId || "").trim()).filter(Boolean);

  return createAndEmit({
    adminIds,
    type: "campaign.brand_confirmed",
    title: "Brand confirmed campaign readiness",
    message: `${campaign.brandName} has reviewed and confirmed "${campaign.productOrServiceName}". It is ready to be published.`,
    entityType: "campaign",
    entityId: String(campaign.campaignsId),
    actionPath: { admin: `/admin/campaigns/view?id=${campaign.campaignsId}` },
  });
}

async function notifyAdminsCampaignPending(campaign, patch = null) {
  const admins = await Admin.find({}, "adminId").lean();
  const adminIds = (admins || []).map((a) => String(a.adminId || "").trim()).filter(Boolean);

  const changedKeys = patch ? Object.keys(patch) : [];
  const changedText = changedKeys.length
    ? ` Changes: ${changedKeys.slice(0, 8).join(", ")}${changedKeys.length > 8 ? "..." : ""}`
    : "";

  return createAndEmit({
    adminIds,
    type: "campaign.pending_update",
    title: "Campaign updated (needs approval)",
    message: `${campaign.brandName} updated "${campaign.productOrServiceName}".${changedText}`,
    entityType: "campaign",
    entityId: String(campaign.campaignsId),
    actionPath: { admin: `/admin/campaigns/view?id=${campaign.campaignsId}` },
  });
}

async function notifyBrandApproved(campaign) {
  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_approved",
    title: "Campaign update approved",
    message: `Admin approved changes for "${campaign.productOrServiceName}".`,
    entityType: "campaign",
    entityId: String(campaign.campaignsId),
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${campaign.campaignsId}` },
  });
}

async function notifyBrandRejected(campaign, note) {
  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_rejected",
    title: "Campaign update rejected",
    message: `Admin rejected changes for "${campaign.productOrServiceName}". ${note ? `Reason: ${note}` : ""}`,
    entityType: "campaign",
    entityId: String(campaign.campaignsId),
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${campaign.campaignsId}` },
  });
}

// ===============================
//  Multer setup
// ===============================
const storage = multer.memoryStorage();
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml']);
const DOC_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);

function fileFilter(req, file, cb) {
  if (file.fieldname === 'image') return cb(null, IMAGE_MIMES.has(file.mimetype));
  if (file.fieldname === 'creativeBrief') return cb(null, DOC_MIMES.has(file.mimetype));
  return cb(null, false);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter
}).fields([
  { name: 'image', maxCount: 10 },
  { name: 'creativeBrief', maxCount: 10 }
]);

// ===============================
//  Subscription & Utils
// ===============================
async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) throw new Error('brandId is required for quota checks');
  const brand = await Brand.findOne({ brandId }, 'subscription').lean();
  if (!brand || !brand.subscription) throw new Error('Brand subscription not configured');
  const feature = getFeature.getFeature(brand.subscription, featureKey);
  if (!feature) return { limit: 0, used: 0, remaining: Infinity };
  const limit = readLimit(feature);
  const used = Number(feature.used || 0) || 0;
  if (limit === 0) return { limit: 0, used, remaining: Infinity };
  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = 'QUOTA_EXCEEDED';
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }
  await Brand.updateOne({ brandId, 'subscription.features.key': featureKey }, { $inc: { 'subscription.features.$.used': amount } });
  return { limit, used: used + amount, remaining: limit - (used + amount) };
}

function readLimit(featureRow) {
  if (!featureRow) return 0;
  const raw = featureRow.limit ?? featureRow.value ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureMonthlyWindow(influencerId, featureKey, featureRow) { return featureRow; }

async function countActiveCollaborationsForInfluencer(influencerId) {
  if (!influencerId) return 0;
  return Contract.countDocuments({ influencerId: String(influencerId), isRejected: { $ne: 1 }, isAccepted: 1 });
}

function activeAcceptedFilter() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }]
  };
}

function activeAcceptedFilter2() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $in: [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED], $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
  };
}

function campaignIdFilter(campaignId) {
  const id = String(campaignId);
  const or = [{ campaignId: id }, { campaignsId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) or.push({ campaignId: new mongoose.Types.ObjectId(id) });
  return { $or: or };
}

function computeIsActive(timeline) {
  if (!timeline || !timeline.endDate) return 1;
  const now = new Date();
  return timeline.endDate < now ? 0 : 1;
}

const toStr = (v) => (v == null ? '' : String(v));

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    { 'milestoneHistory.influencerId': influencerId, 'milestoneHistory.campaignId': { $in: campaignIds } },
    'milestoneHistory.campaignId milestoneHistory.influencerId'
  ).lean();
  const set = new Set();
  docs.forEach((d) => {
    d.milestoneHistory.forEach((e) => {
      if (toStr(e.influencerId) === toStr(influencerId) && campaignIds.includes(toStr(e.campaignId))) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

async function normalizeCategoriesPayload(raw) {
  if (!raw) return [];
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { throw new Error('Invalid JSON in categories.'); }
  }
  if (!Array.isArray(items)) throw new Error('categories must be an array.');

  const catNums = [...new Set(items.map(it => Number(it?.categoryId)).filter(n => Number.isFinite(n)))];
  if (!catNums.length) throw new Error('categories must contain numeric categoryId.');

  const cats = await Category.find({ id: { $in: catNums } }, 'id name subcategories').lean();
  const byNum = new Map(cats.map(c => [c.id, c]));

  const out = [];
  for (const it of items) {
    const catNum = Number(it?.categoryId);
    const subId = String(it?.subcategoryId || '');
    if (!Number.isFinite(catNum)) throw new Error(`Invalid categoryId: ${it?.categoryId}`);
    if (!subId) throw new Error('subcategoryId is required');
    const catDoc = byNum.get(catNum);
    if (!catDoc) throw new Error(`Category not found (id: ${catNum})`);
    const sub = (catDoc.subcategories || []).find(s => String(s.subcategoryId) === subId);
    if (!sub) throw new Error(`Subcategory ${subId} not under category id ${catNum}`);
    out.push({ categoryId: catDoc.id, categoryName: catDoc.name, subcategoryId: sub.subcategoryId, subcategoryName: sub.name });
  }
  return out;
}

function buildSearchOr(term) {
  const or = [
    { brandName: { $regex: term, $options: 'i' } },
    { productOrServiceName: { $regex: term, $options: 'i' } },
    { description: { $regex: term, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: term, $options: 'i' } },
    { 'categories.categoryName': { $regex: term, $options: 'i' } }
  ];
  const num = Number(term);
  if (!isNaN(num)) {
    or.push({ budget: { $lte: num } });
    or.push({ influencerBudget: { $lte: num } });
  }
  return or;
}

async function buildSubToParentNumMap() {
  const rows = await Category.find({}, 'id subcategories').lean();
  const subIdToParentNum = new Map();
  for (const r of rows) {
    for (const s of (r.subcategories || [])) {
      subIdToParentNum.set(String(s.subcategoryId), r.id);
    }
  }
  return subIdToParentNum;
}

async function findMatchingInfluencers({ subIds = [], catNumIds = [] }) {
  if (!subIds.length && !catNumIds.length) return [];
  const or = [];
  if (subIds.length) {
    or.push(
      { 'onboarding.subcategories.subcategoryId': { $in: subIds } },
      { 'subcategories.subcategoryId': { $in: subIds } },
      { 'categories.subcategoryId': { $in: subIds } },
      { 'socialProfiles.categories.subcategoryId': { $in: subIds } },
      { 'categories': { $in: subIds } }
    );
  }
  if (catNumIds.length) {
    or.push(
      { 'onboarding.categoryId': { $in: catNumIds } },
      { 'categories.categoryId': { $in: catNumIds } }
    );
  }
  const filter = or.length ? { $or: or } : {};
  const influencers = await Influencer.find(filter, 'influencerId name primaryPlatform handle onboarding socialProfiles').lean();
  return influencers || [];
}

function addInfluencerOpenStatusGate(filter) {
  filter.$and = filter.$and || [];
  filter.$and.push({ $or: [{ campaignStatus: 'open' }, { campaignStatus: { $exists: false } }] });
  return filter;
}

const CAMPAIGN_STATUS = Object.freeze({ OPEN: "open", PAUSED: "paused" });
const ALLOWED_CAMPAIGN_STATUSES = new Set([CAMPAIGN_STATUS.OPEN, CAMPAIGN_STATUS.PAUSED]);

function normalizeStatus(v) {
  return String(v || "").toLowerCase().trim();
}

exports.updateCampaignStatus = async (req, res) => {
  try {
    const { brandId, campaignId, status } = req.body || {};
    if (!brandId) return res.status(400).json({ message: "brandId is required." });
    if (!campaignId) return res.status(400).json({ message: "campaignId is required." });

    const next = normalizeStatus(status);
    if (!ALLOWED_CAMPAIGN_STATUSES.has(next)) return res.status(400).json({ message: "Invalid status. Use: open | paused" });

    const campaign = await Campaign.findOne({ brandId, ...campaignIdFilter(campaignId) });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    const current = normalizeStatus(campaign.campaignStatus || CAMPAIGN_STATUS.OPEN);
    if (current === "closed") campaign.campaignStatus = CAMPAIGN_STATUS.PAUSED;

    if (next === CAMPAIGN_STATUS.OPEN) {
      const activeFlag = computeIsActive(campaign.timeline);
      if (activeFlag === 0) return res.status(400).json({ message: "Campaign timeline ended. Extend endDate to reopen." });
      campaign.pausedAt = undefined;
    }

    campaign.campaignStatus = next;
    campaign.statusUpdatedAt = new Date();
    if (next === CAMPAIGN_STATUS.PAUSED) campaign.pausedAt = new Date();

    await campaign.save();
    return res.json({ message: "Campaign status updated successfully.", campaign });
  } catch (error) {
    console.error("Error in updateCampaignStatus:", error);
    return res.status(500).json({ message: "Internal server error while updating campaign status." });
  }
};


exports.saveDraftCampaign = (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(500).json({ message: "Error uploading files." });

    try {
      let {
        _id, brandId, productOrServiceName, description = "",
        targetAudience, categories, goal, campaignType,
        creativeBriefText, budget = 0, influencerBudget = 0, timeline, additionalNotes = "",
      } = req.body;

      if (!brandId) return res.status(400).json({ message: "brandId is required." });
      if (!productOrServiceName || !goal) return res.status(400).json({ message: "productOrServiceName and goal are required." });

      const brand = await Brand.findOne({ brandId });
      if (!brand) return res.status(404).json({ message: "Brand not found." });

      // Target Audience
      let audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
      if (targetAudience) {
        let ta = typeof targetAudience === "string" ? JSON.parse(targetAudience) : targetAudience;
        const { age, gender, locations } = ta || {};
        if (age?.MinAge != null) audienceData.age.MinAge = Number(age.MinAge) || 0;
        if (age?.MaxAge != null) audienceData.age.MaxAge = Number(age.MaxAge) || 0;
        if ([0, 1, 2].includes(gender)) audienceData.gender = gender;
        if (Array.isArray(locations)) {
          for (const countryId of locations) {
            const country = await Country.findById(countryId);
            if (country) audienceData.locations.push({ countryId: country._id, countryName: country.countryName });
          }
        }
      }

      // Categories
      let categoriesData = [];
      try { categoriesData = await normalizeCategoriesPayload(categories); } catch (e) { return res.status(400).json({ message: e.message }); }

      // Timeline
      let tlData = {};
      if (timeline) {
        let tl = typeof timeline === "string" ? JSON.parse(timeline) : timeline;
        if (tl.startDate) tlData.startDate = new Date(tl.startDate);
        if (tl.endDate) tlData.endDate = new Date(tl.endDate);
      }

      // Files
      const imagesUploaded = await uploadToGridFS(req.files?.image || [], { prefix: "campaign_image", metadata: { kind: "campaign_image", brandId }, req });
      const creativeUploaded = await uploadToGridFS(req.files?.creativeBrief || [], { prefix: "campaign_brief", metadata: { kind: "campaign_brief", brandId }, req });

      const newImages = imagesUploaded.map((f) => f.filename);
      const newCreativePDFs = creativeUploaded.map((f) => f.filename);

      const actor = await resolveActorFromPayload(req, brandId);

      // ✅ ENFORCE DRAFT STATE
      const baseData = {
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        categories: categoriesData,
        goal,
        campaignType: campaignType || "",
        creativeBriefText,
        budget: toNum(budget),
        influencerBudget: toNum(influencerBudget),
        timeline: tlData,
        additionalNotes,
        isActive: 0,
        isDraft: 1,
        publishStatus: "draft",
        createdBy: actor,
        approvalMode: actor.role === "admin" ? "admin_review" : "direct"
      };

      // 🚨 PREVENT DUPLICATES: Look for an existing draft if _id isn't provided
      let existingDraft = null;
      if (_id) {
        existingDraft = await Campaign.findOne({ _id, isDraft: 1 });
      }
      if (!existingDraft) {
        existingDraft = await Campaign.findOne({ brandId, isDraft: 1 });
      }

      let campaignDoc;
      if (existingDraft) {
        Object.assign(existingDraft, baseData);
        if (newImages.length) existingDraft.images = [...(existingDraft.images || []), ...newImages];
        if (newCreativePDFs.length) existingDraft.creativeBrief = [...(existingDraft.creativeBrief || []), ...newCreativePDFs];
        campaignDoc = await existingDraft.save();
      } else {
        const newDraft = new Campaign({
          ...baseData,
          images: newImages,
          creativeBrief: newCreativePDFs
        });
        campaignDoc = await newDraft.save();

        if (actor.role === "admin") {
          await notifyBrandDraftReady(campaignDoc).catch(console.error);
        }
        // Initiate notification immediately on first draft creation
        await notifyBrandDraftReady(campaignDoc).catch(console.error);
      }

      return res.status(201).json({ message: "Campaign draft saved successfully.", campaign: campaignDoc });
    } catch (error) {
      console.error("Error in saveDraftCampaign:", error);
      return res.status(500).json({ message: "Internal server error while saving draft." });
    }
  });
};

// ==========================================
//  WORKFLOW: 2. ADMIN SENDS DRAFT TO BRAND
// ==========================================
exports.requestBrandReview = async (req, res) => {
  try {
    const campaignsId = req.query.id || req.body.campaignsId;
    if (!isAdminRequest(req)) return res.status(403).json({ message: "Only admins can request brand review." });

    const campaign = await Campaign.findOne({ campaignsId, isDraft: 1 });
    if (!campaign) return res.status(404).json({ message: "Draft campaign not found." });

    campaign.publishStatus = "pending_brand_review";
    await campaign.save();
    await notifyBrandDraftReady(campaign);

    return res.json({ message: "Sent to brand for review.", campaign });
  } catch (error) {
    console.error("Error in requestBrandReview:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ==========================================
//  WORKFLOW: 3. BRAND UPDATES/REVIEWS DRAFT (Existing update endpoint)
// ==========================================
exports.updateCampaign = (req, res) => {
  upload(req, res, async function (err) {
    if (err) return res.status(500).json({ message: 'Error uploading files.' });

    try {
      const campaignsId = req.query.id;
      if (!campaignsId) return res.status(400).json({ message: 'Query parameter id is required.' });

      const updates = { ...req.body };
      delete updates.brandId; delete updates.brandName; delete updates.campaignsId;
      delete updates.createdAt; delete updates.campaignStatus; delete updates.statusUpdatedAt; delete updates.adminId;

      // Handle payload parsing ... [KEEP ALL EXISTING PARSING LOGIC HERE] ...
      if (updates.targetAudience) {
        let ta = typeof updates.targetAudience === 'string' ? JSON.parse(updates.targetAudience) : updates.targetAudience;
        const audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
        if (ta.age?.MinAge) audienceData.age.MinAge = Number(ta.age.MinAge);
        if (ta.age?.MaxAge) audienceData.age.MaxAge = Number(ta.age.MaxAge);
        if ([0, 1, 2].includes(Number(ta.gender))) audienceData.gender = Number(ta.gender);
        const rawLocs = Array.isArray(ta.locations) ? ta.locations : ta.location ? [ta.location] : [];
        for (const loc of rawLocs) {
          const cId = typeof loc === 'string' ? loc : loc?.countryId;
          const country = await Country.findById(cId).lean();
          if (country) audienceData.locations.push({ countryId: country._id, countryName: country.countryName });
        }
        updates.targetAudience = audienceData;
      }
      if (updates.categories !== undefined) updates.categories = await normalizeCategoriesPayload(updates.categories);
      if (updates.timeline) {
        let tl = typeof updates.timeline === 'string' ? JSON.parse(updates.timeline) : updates.timeline;
        const timelineData = {};
        if (tl.startDate) timelineData.startDate = new Date(tl.startDate);
        if (tl.endDate) timelineData.endDate = new Date(tl.endDate);
        updates.timeline = timelineData;
        updates.isActive = computeIsActive(timelineData);
      }
      // ✅ FIX: Safely parse and merge existing images with newly uploaded images
      let finalImages = undefined;
      if (req.body.existingImages !== undefined) {
        try { finalImages = JSON.parse(req.body.existingImages); } catch (e) { finalImages = []; }
      }
      if (req.files?.['image']?.length) {
        const upImgs = await uploadToGridFS(req.files['image'], { prefix: 'campaign_image', metadata: { kind: 'campaign_image', campaignsId }, req });
        finalImages = [...(finalImages || []), ...upImgs.map((f) => f.filename)];
      }
      if (finalImages !== undefined) {
        updates.images = finalImages; // Apply combined list to updates
      }

      // ✅ FIX: Safely parse and merge existing creative briefs with new ones
      let finalBriefs = undefined;
      if (req.body.existingCreativeBrief !== undefined) {
        try { finalBriefs = JSON.parse(req.body.existingCreativeBrief); } catch (e) { finalBriefs = []; }
      }
      if (req.files?.['creativeBrief']?.length) {
        const upBriefs = await uploadToGridFS(req.files['creativeBrief'], { prefix: 'campaign_brief', metadata: { kind: 'campaign_brief', campaignsId }, req });
        finalBriefs = [...(finalBriefs || []), ...upBriefs.map((f) => f.filename)];
      }
      if (finalBriefs !== undefined) {
        updates.creativeBrief = finalBriefs; // Apply combined list to updates
      }

      const campaign = await Campaign.findOne({ campaignsId });
      if (!campaign) return res.status(404).json({ message: "Campaign not found." });

      const actor = await resolveActorFromPayload(req, campaign.brandId);
      const actorIsAdmin = actor.role === "admin";

      // ✅ DRAFT WORKFLOW (admin publishes, non-admin keeps as draft)
      if (campaign.isDraft === 1) {
        if (actorIsAdmin) {
          // admin => publish
          updates.isDraft = 0;
          updates.isActive = 1;
        } else {
          // non-admin => keep draft (vice-versa)
          updates.isDraft = 1;
          updates.isActive = 0;
          updates.publishStatus = "draft";
        }
      }

      // Only trigger pending patch review if the campaign is ALREADY LIVE (isDraft === 0)
      const adminCreated = campaign.approvalMode === "admin_review" || String(campaign.createdBy?.role || "").toLowerCase() === "admin";
      const requiresAdminReview = !actorIsAdmin && adminCreated && campaign.isDraft === 0;

      const base = normalizeForDiff(campaign.toObject());
      const incoming = normalizeForDiff(updates);
      const onlyChanged = diffObject(base, incoming);

      if (!onlyChanged) return res.json({ message: "No changes detected.", campaign: campaign.toObject(), pendingApproval: 0 });

      if (requiresAdminReview) {
        campaign.pendingUpdate = {
          status: "pending", patch: onlyChanged, updatedBy: actor, updatedAt: new Date(),
          reviewedBy: null, reviewedAt: null, reviewNote: "",
        };
        await campaign.save();
        await notifyAdminsCampaignPending(campaign, onlyChanged).catch(console.error);

        return res.json({
          message: "Campaign updated successfully.",
          campaign: { ...campaign.toObject(), ...campaign.pendingUpdate.patch, pendingApproval: 1 }
        });
      }

      updates.pendingUpdate = { status: "none", patch: null, updatedBy: null, updatedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: "" };
      const updatedCampaign = await Campaign.findOneAndUpdate({ campaignsId }, updates, { new: true, runValidators: true }).lean();

      return res.json({ message: "Campaign updated successfully.", campaign: updatedCampaign });
    } catch (error) {
      console.error('Error in updateCampaign:', error);
      return res.status(500).json({ message: 'Internal server error while updating campaign.' });
    }
  });
};

// ==========================================
//  WORKFLOW: 4. BRAND CONFIRMS READINESS
// ==========================================
exports.confirmCampaignReadiness = async (req, res) => {
  try {
    const campaignsId = req.query.id || req.body.campaignsId;

    const campaign = await Campaign.findOne({ campaignsId, isDraft: 1 });
    if (!campaign) return res.status(404).json({ message: "Draft campaign not found." });

    campaign.publishStatus = "brand_confirmed";
    await campaign.save();

    await notifyAdminBrandConfirmed(campaign);

    return res.json({ message: "Campaign marked as ready for publishing.", campaign });
  } catch (error) {
    console.error("Error in confirmCampaignReadiness:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ==========================================
//  WORKFLOW: 5. ADMIN PUBLISHES LIVE
// ==========================================
exports.publishCampaign = async (req, res) => {
  try {
    const campaignsId = req.query.id || req.body.campaignsId;

    const campaign = await Campaign.findOne({ campaignsId, isDraft: 1 });
    if (!campaign) return res.status(404).json({ message: "Draft campaign not found or already published." });

    // ✅ FIX: Consistently resolve the actor to check for Admin status
    const actor = await resolveActorFromPayload(req, campaign.brandId);
    const actorIsAdmin = actor.role === "admin" || isAdminRequest(req);

    // ✅ STRICT CHECK: If it's a managed campaign, ONLY Admin can publish it
    const adminCreated = campaign.approvalMode === "admin_review" || String(campaign.createdBy?.role || "").toLowerCase() === "admin";

    if (adminCreated && !actorIsAdmin) {
      return res.status(403).json({ message: "Only an admin can publish this managed campaign." });
    }

    const activeFlag = computeIsActive(campaign.timeline);
    if (activeFlag === 0) {
      return res.status(400).json({ message: "Campaign timeline has already ended. Extend dates before publishing." });
    }

    // Go Live!
    campaign.isDraft = 0;
    campaign.publishStatus = "published";
    campaign.campaignStatus = "open";
    campaign.isActive = 1;
    await campaign.save();

    // Notify Matching Influencers now that it's live
    try {
      const subIds = Array.from(new Set((campaign.categories || []).map((c) => String(c.subcategoryId))));
      const catNumIds = Array.from(new Set((campaign.categories || []).map((c) => Number(c.categoryId)).filter(Number.isFinite)));

      if (subIds.length || catNumIds.length) {
        const influencers = await findMatchingInfluencers({ subIds, catNumIds });
        if (Array.isArray(influencers) && influencers.length) {
          const actionPath = `/influencer/dashboard/view-campaign?id=${campaign.campaignsId}`;
          await Promise.all(
            influencers.map((inf) =>
              createAndEmit({
                influencerId: String(inf.influencerId),
                type: "campaign.match",
                title: "New campaign matches your profile",
                message: `${campaign.brandName} posted "${campaign.productOrServiceName}".`,
                entityType: "campaign",
                entityId: String(campaign.campaignsId),
                actionPath,
              }).catch(() => null)
            )
          );
        }
      }
    } catch (notifErr) {
      console.warn("publishCampaign: notification flow failed", notifErr.message);
    }

    return res.json({ message: "Campaign published successfully.", campaign });
  } catch (error) {
    console.error("Error in publishCampaign:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


// ===============================
//  STANDARD DIRECT CREATE (For Brands)
// ===============================
exports.createCampaign = (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(500).json({ message: "Error uploading files." });

    try {
      let {
        brandId,
        productOrServiceName,
        description = "",
        targetAudience,
        categories,
        goal,
        campaignType,
        creativeBriefText,
        budget = 0,
        influencerBudget = 0,
        timeline,
        additionalNotes = "",
      } = req.body;

      if (!brandId || !productOrServiceName || !goal) {
        return res.status(400).json({ message: "Missing required fields." });
      }

      const brand = await Brand.findOne({ brandId });
      if (!brand) return res.status(404).json({ message: "Brand not found." });

      // ✅ Resolve actor (admin OR brand)
      const actor = await resolveActorFromPayload(req, brandId);
      const actorIsAdmin = actor.role === "admin" || isAdminRequest(req);

      // ✅ Optional but recommended security:
      // If not admin, ensure brand can only create for itself
      if (!actorIsAdmin) {
        const authBrandId = String(req.user?.brandId || "").trim();
        if (authBrandId && authBrandId !== String(brandId)) {
          return res.status(403).json({ message: "Forbidden: brandId mismatch." });
        }
      }

      // Target Audience
      let audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
      if (targetAudience) {
        let ta = typeof targetAudience === "string" ? JSON.parse(targetAudience) : targetAudience;

        if (ta.age?.MinAge != null) audienceData.age.MinAge = Number(ta.age.MinAge) || 0;
        if (ta.age?.MaxAge != null) audienceData.age.MaxAge = Number(ta.age.MaxAge) || 0;

        if ([0, 1, 2].includes(Number(ta.gender))) audienceData.gender = Number(ta.gender);

        const rawLocs = Array.isArray(ta.locations) ? ta.locations : ta.location ? [ta.location] : [];
        for (const loc of rawLocs) {
          const cId = typeof loc === "string" ? loc : loc?.countryId;
          const country = await Country.findById(cId).lean();
          if (country) {
            audienceData.locations.push({ countryId: country._id, countryName: country.countryName });
          }
        }
      }

      // Categories
      let categoriesData = [];
      try {
        categoriesData = await normalizeCategoriesPayload(categories);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }

      // Timeline
      let tlData = {};
      if (timeline) {
        let tl = typeof timeline === "string" ? JSON.parse(timeline) : timeline;
        if (tl.startDate) tlData.startDate = new Date(tl.startDate);
        if (tl.endDate) tlData.endDate = new Date(tl.endDate);
      }

      // Files (✅ avoid crashes if req.files missing)
      const imagesUploaded = await uploadToGridFS(req.files?.image || [], {
        prefix: "campaign_image",
        metadata: { kind: "campaign_image", brandId },
        req,
      });

      const creativeUploaded = await uploadToGridFS(req.files?.creativeBrief || [], {
        prefix: "campaign_brief",
        metadata: { kind: "campaign_brief", brandId },
        req,
      });

      // ✅ Direct publish (Admin or Brand)
      const baseData = {
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        categories: categoriesData,
        goal,
        campaignType: campaignType || "",
        creativeBriefText,
        budget: toNum(budget),
        influencerBudget: toNum(influencerBudget),
        timeline: tlData,
        additionalNotes,

        isActive: computeIsActive(tlData),
        isDraft: 0,
        publishStatus: "published",
        campaignStatus: "open",
        statusUpdatedAt: new Date(),

        // ✅ this is the key part you asked for (admin role stored)
        createdBy: actor,
        approvalMode: actorIsAdmin ? "admin_review" : "direct",
      };

      const newCampaign = new Campaign({
        ...baseData,
        images: imagesUploaded.map((f) => f.filename),
        creativeBrief: creativeUploaded.map((f) => f.filename),
      });

      const campaignDoc = await newCampaign.save();

      // ✅ Notify matching influencers (same as before)
      try {
        const subIds = Array.from(new Set(categoriesData.map((c) => String(c.subcategoryId))));
        const catNumIds = Array.from(new Set(categoriesData.map((c) => Number(c.categoryId)).filter(Number.isFinite)));

        if (subIds.length || catNumIds.length) {
          const influencers = await findMatchingInfluencers({ subIds, catNumIds });
          if (Array.isArray(influencers) && influencers.length) {
            await Promise.all(
              influencers.map((inf) =>
                createAndEmit({
                  influencerId: String(inf.influencerId),
                  type: "campaign.match",
                  title: "New campaign matches your profile",
                  message: `${campaignDoc.brandName} posted "${campaignDoc.productOrServiceName}".`,
                  entityType: "campaign",
                  entityId: String(campaignDoc.campaignsId),
                  actionPath: `/influencer/dashboard/view-campaign?id=${campaignDoc.campaignsId}`,
                }).catch(() => null)
              )
            );
          }
        }
      } catch (e) {}

      return res.status(201).json({ message: "Campaign created successfully.", campaign: campaignDoc });
    } catch (error) {
      console.error("Error in createCampaign:", error);
      return res.status(500).json({ message: "Internal server error while creating campaign." });
    }
  });
};

// ===============================
//  GET ALL CAMPAIGNS
// ===============================
exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.brandId) filter.brandId = req.query.brandId;
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
    return res.json(campaigns);
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error while fetching campaigns.' });
  }
};

// =======================================
//  GET A SINGLE CAMPAIGN BY campaignsId
// =======================================
exports.getCampaignById = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) return res.status(400).json({ message: 'Query parameter id is required.' });

    const campaign = await Campaign.findOne({ campaignsId }).lean();
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });

    const actorIsAdmin = isAdminRequest(req);
    const actorBrandId = String(req.user?.brandId || "");
    const isOwnerBrand = !actorIsAdmin && actorBrandId && actorBrandId === String(campaign.brandId);

    if ((actorIsAdmin || isOwnerBrand) && campaign.pendingUpdate?.status === "pending" && campaign.pendingUpdate?.patch) {
      return res.json({ ...campaign, pendingApproval: 1, pendingPatch: campaign.pendingUpdate.patch });
    }

    return res.json(campaign);
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ================================
//  DELETE CAMPAIGN BY campaignsId
// ================================
exports.deleteCampaign = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) return res.status(400).json({ message: 'Query parameter id is required.' });

    const deleted = await Campaign.findOneAndDelete({ campaignsId });
    if (!deleted) return res.status(404).json({ message: 'Campaign not found.' });
    return res.json({ message: 'Campaign deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ===============================
//  BRAND / INFLUENCER QUERIES
// ===============================

// Get active campaigns for Brand
exports.getActiveCampaignsByBrand = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10, search = "", sortBy = "createdAt", sortOrder = "desc" } = req.query;
    if (!brandId) return res.status(400).json({ message: "brandId is required." });

    const acceptedIds = await Contract.distinct("campaignId", { brandId, ...activeAcceptedFilter2() });
    const acceptedSet = new Set(acceptedIds.map((id) => String(id)));
    const startOfTodayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));

    // filter ignores drafts automatically because isActive = 1
    const filter = { brandId, isActive: 1, "timeline.endDate": { $gte: startOfTodayUTC } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const sortObj = { [sortBy]: String(sortOrder).toLowerCase() === "asc" ? 1 : -1 };

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).select("-description").sort(sortObj).skip((pageNum - 1) * perPage).limit(perPage).lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.json({
      data: campaigns.map((c) => ({ ...c, influencerWorking: acceptedSet.has(String(c.campaignsId)) })),
      pagination: { total: totalCount, page: pageNum, limit: perPage, totalPages: Math.ceil(totalCount / perPage) }
    });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error." });
  }
};

exports.getPreviousCampaigns = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10, search = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    if (!brandId) return res.status(400).json({ message: 'Query parameter brandId is required.' });

    const filter = { brandId, isActive: 0, isDraft: 0 }; // hide drafts from previous tab
    if (search) filter.$or = buildSearchOr(search);

    const sortObj = { [sortBy]: String(sortOrder).toLowerCase() === 'asc' ? 1 : -1 };
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1);

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).sort(sortObj).skip(skip).limit(Math.max(parseInt(limit, 10), 1)).lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({ data: campaigns, pagination: { total: totalCount, page: Math.max(parseInt(page, 10), 1), limit: Math.max(parseInt(limit, 10), 1), totalPages: Math.ceil(totalCount / Math.max(parseInt(limit, 10), 1)) } });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

exports.getActiveCampaignsByCategories = async (req, res) => {
  try {
    let { subcategoryIds, search, page = 1, limit = 10 } = req.body;
    if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) return res.status(400).json({ message: 'subcategoryId required' });

    const filter = addInfluencerOpenStatusGate({ isActive: 1, isDraft: { $ne: 1 }, 'categories.subcategoryId': { $in: subcategoryIds.map(String) } });
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);
    return res.json({ meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) }, campaigns });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.checkApplied = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) return res.status(400).json({ message: 'Missing fields' });
  try {
    const campaign = await Campaign.findOne({ campaignsId: campaignId }).lean();
    if (!campaign) return res.status(404).json({ message: 'Not found.' });
    campaign.hasApplied = await ApplyCampaign.exists({ campaignId, 'applicants.influencerId': influencerId }) ? 1 : 0;
    return res.json(campaign);
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId required' });

  try {
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const subIdToParentNum = await buildSubToParentNumMap();
    const selectedSubIds = new Set((inf.onboarding?.subcategories || []).map(s => s?.subcategoryId).filter(Boolean).map(String));
    const selectedCatNumIds = new Set();
    if (typeof inf.onboarding?.categoryId === 'number') selectedCatNumIds.add(inf.onboarding.categoryId);

    for (const subId of selectedSubIds) {
      const parentNum = subIdToParentNum.get(subId);
      if (typeof parentNum === 'number') selectedCatNumIds.add(parentNum);
    }

    if (selectedSubIds.size === 0 && selectedCatNumIds.size === 0) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const orClauses = [];
    if (selectedSubIds.size) orClauses.push({ 'categories.subcategoryId': { $in: Array.from(selectedSubIds) } });
    if (selectedCatNumIds.size) orClauses.push({ 'categories.categoryId': { $in: Array.from(selectedCatNumIds) } });

    // Ensure influencers don't see drafts
    const filter = { isActive: 1, isDraft: { $ne: 1 }, $or: orClauses };
    if (search?.trim()) filter.$and = [{ $or: buildSearchOr(search.trim()) }];

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);

    let canApply = true;
    const applyF = (inf.subscription?.features || []).find(f => f.key === 'apply_to_campaigns_quota');
    if (applyF) {
      const fReset = await ensureMonthlyWindow(influencerId, 'apply_to_campaigns_quota', applyF);
      if (readLimit(fReset) > 0 && Number(fReset.used || 0) >= readLimit(fReset)) canApply = false;
    }
    const cap = readLimit((inf.subscription?.features || []).find(f => f.key === 'active_collaborations_limit'));
    if (cap > 0 && await countActiveCollaborationsForInfluencer(influencerId) >= cap) canApply = false;

    return res.json({ meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) }, campaigns: campaigns.map((c) => ({ ...c, hasApplied: 0, hasApproved: 0, isContracted: 0, contractId: null, isAccepted: 0, canApply })) });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getApprovedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId required' });
  try {
    const contracts = await Contract.find({ influencerId, isAssigned: 1 }, 'campaignId contractId isAccepted feeAmount status milestonesCreatedAt').lean();
    let campaignIds = contracts.map((c) => toStr(c.campaignId));
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const applyRecs = await ApplyCampaign.find({ campaignId: { $in: campaignIds }, 'applicants.influencerId': influencerId }, 'campaignId').lean();
    const appliedIds = new Set(applyRecs.map((r) => toStr(r.campaignId)));
    campaignIds = campaignIds.filter((id) => appliedIds.has(id));
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const milestoneIds = await milestoneSetForInfluencer(influencerId, campaignIds);
    campaignIds = campaignIds.filter((id) => milestoneIds.has(id));
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const contractIdMap = new Map(); const feeMap = new Map(); const acceptedMap = new Map(); const statusMap = new Map(); const milestonesCreatedAtMap = new Map();
    contracts.forEach((c) => {
      const cid = toStr(c.campaignId);
      if (new Set(campaignIds).has(cid)) {
        contractIdMap.set(cid, c.contractId); feeMap.set(cid, Number(c.feeAmount || 0));
        acceptedMap.set(cid, c.isAccepted === 1 ? 1 : 0); statusMap.set(cid, c.status || null);
        milestonesCreatedAtMap.set(cid, c.milestonesCreatedAt || null);
      }
    });

    const filter = { campaignsId: { $in: campaignIds }, isActive: 1 };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, raw] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: raw.map((c) => ({ ...c, hasApplied: 1, isContracted: 1, isAccepted: acceptedMap.get(toStr(c.campaignsId)) || 0, hasMilestone: 1, contractId: contractIdMap.get(toStr(c.campaignsId)) || null, feeAmount: feeMap.get(toStr(c.campaignsId)) || 0, contractStatus: statusMap.get(toStr(c.campaignsId)) || null, milestonesCreatedAt: milestonesCreatedAtMap.get(toStr(c.campaignsId)) || null }))
    });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getAppliedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId required' });
  try {
    const applyRecs = await ApplyCampaign.find({ 'applicants.influencerId': influencerId }, 'campaignId').lean();
    let campaignIds = applyRecs.map((r) => r.campaignId);
    if (!campaignIds.length) return res.status(200).json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const contracted = await Contract.find({ influencerId, campaignId: { $in: campaignIds }, $or: [{ isAssigned: 1 }, { isAccepted: 1 }] }, 'campaignId').lean();
    const excludedIds = new Set(contracted.map((c) => c.campaignId));
    campaignIds = campaignIds.filter((id) => !excludedIds.has(id));
    if (!campaignIds.length) return res.status(200).json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter, '-description').sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: rawCampaigns.map(({ description, ...c }) => ({ ...c, hasApplied: 1, isContracted: 0, isAccepted: 0 }))
    });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getAcceptedCampaigns = async (req, res) => {
  const { brandId, search, page = 1, limit = 10 } = req.body;
  if (!brandId) return res.status(400).json({ message: "brandId required" });

  try {
    const contracts = await Contract.find({
      brandId: String(brandId), isRejected: { $ne: 1 },
      status: { $in: [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED] },
      $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
    }, "campaignId contractId influencerId feeAmount lastActionAt createdAt status").sort({ lastActionAt: -1, createdAt: -1 }).lean();

    const campaignIds = [...new Set(contracts.map((c) => String(c.campaignId)))];
    if (!campaignIds.length) return res.status(200).json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const contractMap = new Map(); const influencerMap = new Map(); const feeMap = new Map(); const statusMap = new Map(); const signedCountByCampaign = new Map();
    for (const c of contracts) {
      const key = String(c.campaignId);
      if (!contractMap.has(key)) {
        contractMap.set(key, c.contractId || null); influencerMap.set(key, c.influencerId || null);
        feeMap.set(key, Number(c.feeAmount || 0)); statusMap.set(key, c.status || null);
      }
      signedCountByCampaign.set(key, (signedCountByCampaign.get(key) || 0) + 1);
    }

    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean(),
    ]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: campaigns.map((camp) => ({
        ...camp, contractId: contractMap.get(String(camp.campaignsId)) || null,
        influencerId: influencerMap.get(String(camp.campaignsId)) || null, feeAmount: feeMap.get(String(camp.campaignsId)) || 0,
        contractStatus: statusMap.get(String(camp.campaignsId)) || null, isAccepted: 1,
        totalAcceptedMembers: signedCountByCampaign.get(String(camp.campaignsId)) || 0, applicantCount: Math.max(0, (Number(camp.applicantCount) || 0)),
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAcceptedInfluencers = async (req, res) => {
  const { campaignId, search = "", page = 1, limit = 10, sortBy = "createdAt", order = "desc" } = req.body;
  if (!campaignId) return res.status(400).json({ message: "campaignId required" });

  try {
    const contracts = await Contract.find({
      ...campaignIdFilter(campaignId), isRejected: { $ne: 1 },
      status: { $in: [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED] },
      $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
    }, "influencerId contractId feeAmount lastActionAt createdAt status").sort({ lastActionAt: -1, createdAt: -1 }).lean();

    const influencerIds = contracts.map((c) => String(c.influencerId));
    if (!influencerIds.length) return res.status(200).json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, influencers: [] });

    const contractMap = new Map(); const feeMap = new Map();
    for (const c of contracts) {
      const key = String(c.influencerId);
      if (!contractMap.has(key)) { contractMap.set(key, c.contractId || null); feeMap.set(key, Number(c.feeAmount || 0)); }
    }

    const filter = { influencerId: { $in: Array.from(contractMap.keys()) } };
    if (search?.trim()) filter.$or = [{ name: new RegExp(search.trim(), "i") }, { handle: new RegExp(search.trim(), "i") }, { email: new RegExp(search.trim(), "i") }];

    const sortField = { createdAt: "createdAt", name: "name", followerCount: "followerCount", feeAmount: "feeAmount" }[sortBy] || "createdAt";
    const sortDir = String(order).toLowerCase() === "asc" ? 1 : -1;
    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));

    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter).sort(sortField === "feeAmount" ? {} : { [sortField]: sortDir }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).select("-passwordHash -__v").lean(),
    ]);

    if (!rawInfluencers.length) return res.json({ meta: { total: 0, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: 0 }, influencers: [] });

    const modashProfiles = await Modash.find({ influencerId: { $in: rawInfluencers.map((i) => String(i.influencerId)) } }, "influencerId username handle followers provider").lean();
    const modashByInfluencerId = new Map();
    for (const m of modashProfiles) {
      if (!modashByInfluencerId.has(String(m.influencerId))) modashByInfluencerId.set(String(m.influencerId), []);
      modashByInfluencerId.get(String(m.influencerId)).push(m);
    }

    function pickPrimaryProfile(influencerDoc, profilesForInfluencer) {
      if (!profilesForInfluencer?.length) return null;
      if (["youtube", "instagram", "tiktok"].includes((influencerDoc.primaryPlatform || "").toLowerCase())) {
        const direct = profilesForInfluencer.find((p) => String(p.provider || "").toLowerCase() === (influencerDoc.primaryPlatform || "").toLowerCase());
        if (direct) return direct;
      }
      return profilesForInfluencer.reduce((best, current) => (Number(current?.followers || 0) > Number(best?.followers || 0) ? current : best), null);
    }

    let influencers = rawInfluencers.map((inf) => {
      const key = String(inf.influencerId);
      const primaryProfile = pickPrimaryProfile(inf, modashByInfluencerId.get(key) || []);
      return {
        ...inf, contractId: contractMap.get(key) || null, feeAmount: feeMap.get(key) || 0, isAccepted: 1,
        socialHandle: (primaryProfile && (primaryProfile.username || primaryProfile.handle)) || inf.handle || null,
        audienceSize: primaryProfile && typeof primaryProfile.followers === "number" ? primaryProfile.followers : (typeof inf.followerCount === "number" ? inf.followerCount : 0),
        primaryPlatform: inf.primaryPlatform || null, primaryProvider: primaryProfile ? primaryProfile.provider : null,
      };
    });

    if (sortField === "feeAmount") influencers.sort((a, b) => sortDir === 1 ? a.feeAmount - b.feeAmount : b.feeAmount - a.feeAmount);

    return res.json({ meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) }, influencers });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: "influencerId is required" });

  try {
    const contracts = await Contract.find({
      influencerId: String(influencerId), isRejected: { $ne: 1 },
      status: { $in: [CONTRACT_STATUS.BRAND_SENT_DRAFT, CONTRACT_STATUS.BRAND_EDITED, CONTRACT_STATUS.INFLUENCER_EDITED, CONTRACT_STATUS.BRAND_ACCEPTED, CONTRACT_STATUS.INFLUENCER_ACCEPTED, CONTRACT_STATUS.READY_TO_SIGN, CONTRACT_STATUS.CONTRACT_SIGNED, "sent", "viewed", "negotiation", "finalize", "signing", "locked"] },
      $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
    }, "campaignId contractId feeAmount isAccepted status lastActionAt createdAt").sort({ lastActionAt: -1, createdAt: -1 }).lean();

    if (!contracts.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const contractByCampaignId = new Map();
    for (const c of contracts) if (String(c.campaignId || "") && !contractByCampaignId.has(String(c.campaignId || ""))) contractByCampaignId.set(String(c.campaignId || ""), { contractId: c.contractId || null, feeAmount: Number(c.feeAmount || 0), isAccepted: c.isAccepted === 1 ? 1 : 0, status: c.status || null, campaignIdRaw: c.campaignId });

    let candidateCampaignIds = Array.from(contractByCampaignId.keys());
    if (!candidateCampaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const idsObj = candidateCampaignIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    const milestoneDocs = await Milestone.find({ milestoneHistory: { $elemMatch: { influencerId: String(influencerId), campaignId: { $in: [...candidateCampaignIds, ...idsObj] } } } }, "milestoneHistory.campaignId milestoneHistory.influencerId").lean();

    const milestoneCampaignSet = new Set();
    for (const d of milestoneDocs) for (const h of d.milestoneHistory || []) if (String(h.influencerId) === String(influencerId)) milestoneCampaignSet.add(String(h.campaignId));

    for (const [campId, details] of contractByCampaignId.entries()) {
      if (details?.status === CONTRACT_STATUS.MILESTONES_CREATED || (milestoneCampaignSet.has(String(campId)) && details?.status === CONTRACT_STATUS.CONTRACT_SIGNED)) contractByCampaignId.delete(campId);
    }

    candidateCampaignIds = Array.from(contractByCampaignId.keys());
    if (!candidateCampaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const uuidIds = []; const oIds = [];
    for (const id of candidateCampaignIds) { if (mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id) { oIds.push(new mongoose.Types.ObjectId(id)); } else { uuidIds.push(String(id)); } }

    let baseFilter = (uuidIds.length && oIds.length) ? { $or: [{ campaignsId: { $in: uuidIds } }, { _id: { $in: oIds } }] } : uuidIds.length ? { campaignsId: { $in: uuidIds } } : { _id: { $in: oIds } };
    let filter = search?.trim() ? { $and: [baseFilter, { $or: buildSearchOr(search.trim()) }] } : baseFilter;

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, rawCampaigns] = await Promise.all([Campaign.countDocuments(filter), Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: rawCampaigns.map((c) => {
        const details = contractByCampaignId.get(String(c.campaignsId || "")) || contractByCampaignId.get(String(c._id || "")) || {};
        return { ...c, hasApplied: 1, isContracted: 1, isAccepted: details.isAccepted || 0, hasMilestone: (milestoneCampaignSet.has(String(c.campaignsId || "")) || milestoneCampaignSet.has(String(c._id || ""))) ? 1 : 0, contractId: details.contractId ?? null, feeAmount: details.feeAmount ?? 0, contractStatus: details.status ?? null };
      }),
    });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCampaignsByFilter = async (req, res) => {
  try {
    const { subcategoryIds = [], categoryIds = [], gender, minAge, maxAge, ageMode = 'containment', countryId, goal, minBudget, maxBudget, search = '', page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = req.body;
    const filter = addInfluencerOpenStatusGate({ isActive: 1, isDraft: { $ne: 1 } }); // hide drafts

    if (Array.isArray(subcategoryIds) && subcategoryIds.length) filter['categories.subcategoryId'] = { $in: subcategoryIds.map(String) };
    if (Array.isArray(categoryIds) && categoryIds.length) {
      const nums = categoryIds.map(v => Number(v)).filter(n => Number.isFinite(n));
      const maybeObjIds = categoryIds.filter(v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v));
      let fromObj = [];
      if (maybeObjIds.length) { const rows = await Category.find({ _id: { $in: maybeObjIds } }, 'id').lean(); fromObj = rows.map(r => r.id).filter(n => Number.isFinite(n)); }
      const combined = [...new Set([...nums, ...fromObj])];
      if (combined.length) filter['categories.categoryId'] = { $in: combined };
    }

    if ([0, 1].includes(Number(gender))) filter['targetAudience.gender'] = Number(gender);
    const minA = Number(minAge); const maxA = Number(maxAge);
    if (!isNaN(minA) || !isNaN(maxA)) {
      if (ageMode === 'containment') {
        if (!isNaN(minA)) filter['targetAudience.age.MinAge'] = { $gte: minA };
        if (!isNaN(maxA)) filter['targetAudience.age.MaxAge'] = { $lte: maxA };
      } else {
        if (!isNaN(maxA)) filter['targetAudience.age.MinAge'] = { $lte: maxA };
        if (!isNaN(minA)) filter['targetAudience.age.MaxAge'] = { $gte: minA };
      }
    }

    if (Array.isArray(countryId) && countryId.length) {
      const validIds = countryId.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
      if (validIds.length) filter['targetAudience.locations'] = { $elemMatch: { countryId: { $in: validIds } } };
    } else if (countryId && mongoose.Types.ObjectId.isValid(countryId)) {
      filter['targetAudience.locations'] = { $elemMatch: { countryId: new mongoose.Types.ObjectId(countryId) } };
    }

    if (goal && ['Brand Awareness', 'Sales', 'Engagement'].includes(goal)) filter.goal = goal;
    const minB = Number(minBudget); const maxB = Number(maxBudget);
    if (!isNaN(minB) || !isNaN(maxB)) {
      filter.budget = {};
      if (!isNaN(minB)) filter.budget.$gte = minB;
      if (!isNaN(maxB)) filter.budget.$lte = maxB;
    }
    if (typeof search === 'string' && search.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const sortObj = { [['createdAt', 'budget', 'goal', 'brandName'].includes(sortBy) ? sortBy : 'createdAt']: sortOrder === 'asc' ? 1 : -1 };

    const [total, campaigns] = await Promise.all([Campaign.countDocuments(filter), Campaign.find(filter).sort(sortObj).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()]);
    return res.json({ data: campaigns, pagination: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) } });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error while filtering campaigns.' });
  }
};

exports.getRejectedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search = '', page = 1, limit = 10 } = req.body || {};
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const candidates = await Contract.find({ influencerId: String(influencerId), $or: [{ status: 'rejected' }, { isRejected: 1 }], $and: [{ $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: '' }] }] }, 'contractId campaignId feeAmount createdAt audit supersededBy').lean();
    if (!candidates.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const children = await Contract.find({ resendOf: { $in: candidates.map(c => String(c.contractId)) } }, 'resendOf').lean();
    const parentsWithChildren = new Set(children.map(ch => String(ch.resendOf)));
    const finalRejected = candidates.filter(c => !parentsWithChildren.has(String(c.contractId)));
    if (!finalRejected.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const latestByCampaign = new Map();
    for (const c of finalRejected) {
      const key = String(c.campaignId);
      const prev = latestByCampaign.get(key);
      if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) latestByCampaign.set(key, c);
    }

    const campFilter = { campaignsId: { $in: Array.from(latestByCampaign.keys()) } };
    if (typeof search === 'string' && search.trim()) campFilter.$or = buildSearchOr(search.trim());

    const allMatched = await Campaign.find(campFilter).sort({ createdAt: -1 }).lean();
    const start = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const slice = allMatched.slice(start, start + Math.max(1, parseInt(limit, 10)));

    return res.json({
      meta: { total: allMatched.length, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(allMatched.length / Math.max(1, parseInt(limit, 10))) },
      campaigns: slice.map((camp) => {
        const parent = latestByCampaign.get(String(camp.campaignsId)) || {};
        let rejectedAt = parent.createdAt || null; let reason = '';
        if (Array.isArray(parent.audit)) {
          const rejEvents = parent.audit.filter(e => e?.type === 'REJECTED');
          if (rejEvents.length) {
            rejEvents.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
            rejectedAt = rejEvents[rejEvents.length - 1].at || rejectedAt;
            reason = (rejEvents[rejEvents.length - 1].details && rejEvents[rejEvents.length - 1].details.reason) || '';
          }
        }
        return { ...camp, hasApplied: 1, isContracted: 0, isAccepted: 0, isRejected: 1, contractId: parent.contractId || null, feeAmount: Number(parent.feeAmount || 0), rejectedAt, rejectionReason: reason };
      })
    });
  } catch (err) {
    return res.status(500).json({ message: 'Internal server error while fetching rejected campaigns.' });
  }
};

exports.getCampaignSummary = async (req, res) => {
  try {
    const campaignsId = req.query.id || req.params?.id;
    if (!campaignsId) return res.status(400).json({ message: 'Query parameter id is required.' });
    const campaign = await Campaign.findOne({ campaignsId }, 'productOrServiceName budget timeline').lean();
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
    return res.json({ campaignName: campaign.productOrServiceName, budget: campaign.budget ?? 0, timeline: campaign.timeline || {} });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getDraftCampaignByBrand = async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ message: "brandId is required as a query param." });
    const draft = await Campaign.findOne({ brandId, isDraft: 1 }).sort({ updatedAt: -1 }).lean();
    if (!draft) return res.status(201).json({ message: "No draft found for this brand." });
    return res.status(200).json(draft);
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCampaignHistoryByBrand = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10, search = "", sortBy = "createdAt", sortOrder = "desc", includeDescription = 1, campaignStatus, timelineState, goal, minBudget, maxBudget } = req.body || {};
    if (!brandId) return res.status(400).json({ message: "brandId is required." });

    const filter = { brandId, isDraft: { $ne: 1 } }; // NEVER show drafts in standard history
    if (search && String(search).trim()) filter.$or = buildSearchOr(String(search).trim());
    if (campaignStatus && ["open", "paused"].includes(String(campaignStatus).toLowerCase().trim())) filter.campaignStatus = String(campaignStatus).toLowerCase().trim();
    if (goal) filter.goal = String(goal);

    if (minBudget !== undefined || maxBudget !== undefined) {
      filter.budget = {};
      if (minBudget !== undefined && minBudget !== null && String(minBudget).trim() !== "" && Number.isFinite(Number(minBudget))) filter.budget.$gte = Number(minBudget);
      if (maxBudget !== undefined && maxBudget !== null && String(maxBudget).trim() !== "" && Number.isFinite(Number(maxBudget))) filter.budget.$lte = Number(maxBudget);
      if (!Object.keys(filter.budget).length) delete filter.budget;
    }

    const startOfTodayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    if (timelineState) {
      const state = String(timelineState).toLowerCase().trim();
      filter.$and = filter.$and || [];
      if (state === "none") {
        filter.$and.push({ $and: [{ $or: [{ "timeline.startDate": { $exists: false } }, { "timeline.startDate": null }] }, { $or: [{ "timeline.endDate": { $exists: false } }, { "timeline.endDate": null }] }] });
      } else if (state === "expired") {
        filter.$and.push({ "timeline.endDate": { $exists: true, $ne: null, $lt: startOfTodayUTC } });
      } else if (state === "running") {
        filter.$and.push({ $and: [{ $or: [{ "timeline.startDate": { $exists: true, $ne: null } }, { "timeline.endDate": { $exists: true, $ne: null } }] }, { $or: [{ "timeline.endDate": { $exists: false } }, { "timeline.endDate": null }, { "timeline.endDate": { $gte: startOfTodayUTC } }] }] });
      }
    }

    const sortObj = { [{ createdAt: "createdAt", budget: "budget", campaignStatus: "campaignStatus", statusUpdatedAt: "statusUpdatedAt", productOrServiceName: "productOrServiceName", isActive: "isActive" }[sortBy] || "createdAt"]: String(sortOrder).toLowerCase() === "asc" ? 1 : -1 };
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * Math.max(parseInt(limit, 10) || 10, 1);

    const [rows, total] = await Promise.all([
      Campaign.find(filter, Number(includeDescription) === 1 ? undefined : "-description").sort(sortObj).skip(skip).limit(Math.max(parseInt(limit, 10) || 10, 1)).lean(),
      Campaign.countDocuments(filter),
    ]);

    const workingIds = await Contract.distinct("campaignId", { brandId, campaignId: { $in: rows.map((c) => String(c.campaignsId || c._id)) }, ...activeAcceptedFilter() });
    const workingSet = new Set(workingIds.map(String));

    return res.json({
      data: rows.map((c) => {
        const tl = c.timeline || {};
        const state = (!tl.startDate && !tl.endDate) ? "none" : (tl.endDate && new Date(tl.endDate) < startOfTodayUTC) ? "expired" : "running";
        return { ...c, computedIsActive: computeIsActive(c.timeline), timelineState: state, hasTimeline: state !== "none", influencerWorking: workingSet.has(String(c.campaignsId || "")) || workingSet.has(String(c._id || "")) };
      }),
      pagination: { total, page: Math.max(parseInt(page, 10) || 1, 1), limit: Math.max(parseInt(limit, 10) || 10, 1), totalPages: Math.ceil(total / Math.max(parseInt(limit, 10) || 10, 1)) },
    });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.listApplicants = async (req, res) => {
  const { campaignId, page = 1, limit = 10, search = "", sortField = "createdAt", sortOrder = 1, audienceBucket = "all" } = req.body || {};
  if (!campaignId) return res.status(400).json({ message: "campaignId is required" });

  try {
    const record = await ApplyCampaign.findOne({ campaignId }).lean();
    const influencerIds = (record?.applicants || []).map((a) => a?.influencerId).filter(Boolean).map(String);
    if (!influencerIds.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, applicantCount: 0, influencers: [] });

    const [influencersRaw, modashProfiles, contracts, milestoneDocs] = await Promise.all([
      Influencer.find({ influencerId: { $in: influencerIds } }, "influencerId name primaryPlatform onboarding.categoryName onboarding.subcategories").lean(),
      Modash.find({ influencerId: { $in: influencerIds } }, "influencerId provider handle username fullname followers").lean(),
      Contract.find({ campaignId: String(campaignId), influencerId: { $in: influencerIds } }, "influencerId contractId feeAmount isAccepted isAssigned isRejected rejectedReason status").lean(),
      Milestone.find({ milestoneHistory: { $elemMatch: { campaignId: String(campaignId), influencerId: { $in: influencerIds } } } }, "milestoneHistory").lean()
    ]);

    const modashByInf = new Map();
    for (const p of modashProfiles) if (String(p.influencerId || "")) { if (!modashByInf.has(String(p.influencerId))) modashByInf.set(String(p.influencerId), []); modashByInf.get(String(p.influencerId)).push(p); }

    const contractByInf = new Map(contracts.map((c) => [String(c.influencerId), c]));
    const milestoneInfSet = new Set();
    for (const doc of milestoneDocs) for (const h of doc.milestoneHistory || []) if (String(h.campaignId) === String(campaignId)) milestoneInfSet.add(String(h.influencerId));

    let rows = (influencersRaw || []).map((inf) => {
      const infId = String(inf.influencerId);
      const profiles = modashByInf.get(infId) || [];
      const chosen = profiles.find((p) => String(p.provider).toLowerCase() === String(inf.primaryPlatform).toLowerCase()) || profiles.slice().sort((a, b) => (Number(b.followers) || 0) - (Number(a.followers) || 0))[0] || null;
      let handle = (chosen && (chosen.handle || chosen.username || chosen.fullname || "").trim()) || null;
      if (handle && !handle.startsWith("@")) handle = "@" + handle;
      const c = contractByInf.get(infId);
      const isRejected = c?.isRejected === 1 ? 1 : 0;
      return {
        _id: inf._id || "", influencerId: infId, name: inf.name || "", handle, categoryName: inf?.onboarding?.categoryName || "—",
        audienceSize: profiles.reduce((sum, p) => sum + (Number(p?.followers) || 0), 0), createdAt: record.createdAt || record._id?.getTimestamp?.() || null,
        isRejected, rejectedReason: c?.rejectedReason || null, isAssigned: isRejected ? 0 : (c?.isAssigned === 1 ? 1 : 0), isAccepted: isRejected ? 0 : (c?.isAccepted === 1 ? 1 : 0),
        isContracted: c ? 1 : 0, contractId: c?.contractId || null, hasMilestone: milestoneInfSet.has(infId) ? 1 : 0,
      };
    });

    const term = String(search || "").trim().toLowerCase();
    if (term) rows = rows.filter((r) => String(r.name || "").toLowerCase().includes(term) || String(r.handle || "").toLowerCase().includes(term) || String(r.categoryName || "").toLowerCase().includes(term));
    if (audienceBucket === "k") rows = rows.filter((r) => Number(r.audienceSize) >= 1000 && Number(r.audienceSize) < 1_000_000);
    else if (audienceBucket === "m") rows = rows.filter((r) => Number(r.audienceSize) >= 1_000_000);

    const dir = sortOrder === 1 ? -1 : 1;
    if (new Set(["name", "handle", "categoryName", "audienceSize", "createdAt"]).has(sortField)) {
      rows.sort((a, b) => {
        if (sortField === "createdAt") return dir * ((a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
        if (sortField === "audienceSize") return dir * ((Number(a.audienceSize) || 0) - (Number(b.audienceSize) || 0));
        return dir * String(a[sortField] ?? "").localeCompare(String(b[sortField] ?? ""));
      });
    }

    const start = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    return res.json({ meta: { total: rows.length, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(rows.length / Math.max(1, parseInt(limit, 10))) }, applicantCount: record.applicants?.length || 0, influencers: rows.slice(start, start + Math.max(1, parseInt(limit, 10))) });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.approveCampaignPendingUpdate = async (req, res) => {
  try {
    const actor = await resolveActorFromPayload(req);
    if (actor.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const campaign = await Campaign.findOne({ campaignsId: req.query.id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    if (campaign.pendingUpdate?.status !== "pending" || !campaign.pendingUpdate?.patch) {
      return res.status(400).json({ message: "No pending update to approve." });
    }

    Object.assign(campaign, campaign.pendingUpdate.patch);
    campaign.pendingUpdate = { status: "approved", patch: null, updatedBy: campaign.pendingUpdate.updatedBy, updatedAt: campaign.pendingUpdate.updatedAt, reviewedBy: { role: "admin", userId: String(req.user?.id || req.user?.adminId || "") }, reviewedAt: new Date(), reviewNote: String(req.body?.note || "") };
    await campaign.save();
    await notifyBrandApproved(campaign);

    return res.json({ message: "Approved and published.", campaign });
  } catch (e) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.rejectCampaignPendingUpdate = async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ message: "Forbidden" });

    const note = String(req.body?.note || "Rejected");
    const campaign = await Campaign.findOne({ campaignsId: req.query.id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    if (campaign.pendingUpdate?.status !== "pending") return res.status(400).json({ message: "No pending update to reject." });

    campaign.pendingUpdate = { status: "rejected", patch: null, updatedBy: campaign.pendingUpdate.updatedBy, updatedAt: campaign.pendingUpdate.updatedAt, reviewedBy: { role: "admin", userId: String(req.user?.id || req.user?.adminId || "") }, reviewedAt: new Date(), reviewNote: note };
    await campaign.save();
    await notifyBrandRejected(campaign, note);

    return res.json({ message: "Rejected.", campaign });
  } catch (e) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAdminCampaigns = async (req, res) => {
  try {
    const { brandId } = req.params;

    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const skip = (page - 1) * limit;

    // optional: include old drafts if you ever need them
    const includeDrafts = String(req.query.includeDrafts || "0") === "1";

    const filter = {
      ...(brandId ? { brandId: String(brandId) } : {}),
      // admin-created (robust for old data)
      $or: [
        { "createdBy.role": "admin" },
        { "createdBy.role": { $regex: /^admin$/i } },
        { approvalMode: "admin_review" },
      ],
      ...(includeDrafts ? {} : { isDraft: { $ne: 1 } }), // hide drafts by default
    };

    const [data, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
};