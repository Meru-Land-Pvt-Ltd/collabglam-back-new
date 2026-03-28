require("dotenv").config();
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const OLD_URI = process.env.MONGODB_URI1 || process.env.MONGODB_URI1;
const NEW_URI = process.env.MONGODB_URI || process.env.MONGODB_URI;

// safety defaults
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const PATCH_EXISTING = String(process.env.PATCH_EXISTING || "true").toLowerCase() === "true";
const KEEP_V2_PASSWORD = String(process.env.KEEP_V2_PASSWORD || "true").toLowerCase() === "true";

function str(v, d = "") {
  return v == null ? d : String(v);
}
function trim(v, d = "") {
  return str(v, d).trim();
}
function lower(v, d = "") {
  return trim(v, d).toLowerCase();
}
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function dt(v, d = null) {
  if (!v) return d;
  const x = new Date(v);
  return Number.isFinite(x.getTime()) ? x : d;
}
function isNonEmpty(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}
function bcryptHashLike(v) {
  const s = str(v);
  return /^\$2[aby]\$\d{2}\$/.test(s) && s.length === 60;
}
function uniqueBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of arr || []) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
function campaignFingerprint(doc) {
  const brandId = str(doc.brandId);
  const title = lower(doc.campaignTitle || doc.productOrServiceName || "");
  const startAt = doc.startAt ? new Date(doc.startAt).toISOString() : "";
  const endAt = doc.endAt ? new Date(doc.endAt).toISOString() : "";
  return `${brandId}__${title}__${startAt}__${endAt}`;
}
function mapCampaignStatus(oldDoc) {
  if (Number(oldDoc?.isDraft) === 1) {
    return { status: "draft", publishStatus: "draft", isDraft: 1, isActive: 0 };
  }
  if (lower(oldDoc?.campaignStatus) === "paused") {
    return { status: "paused", publishStatus: "published", isDraft: 0, isActive: Number(oldDoc?.isActive ?? 1) };
  }
  return { status: "active", publishStatus: "published", isDraft: 0, isActive: Number(oldDoc?.isActive ?? 1) };
}

function buildBrandFromOld(old) {
  return {
    _id: new ObjectId(),

    // temporary legacy field
    brandId: trim(old.brandId),

    email: lower(old.email),
    brandName: trim(old.name || old.brandName || "Unknown Brand"),
    name: trim(old.pocName || old.name || old.brandName || ""),
    companySize: trim(old.companySize || ""),
    industry: trim(old.businessType || old.categoryName || old.industry || "Unknown"),

    // keep old password/hash exactly
    password: str(old.password || ""),

    proxyEmail: lower(old.brandAliasEmail || old.proxyEmail || ""),
    profilePic: trim(old.logoUrl || old.profilePic || ""),

    page1: Array.isArray(old.page1) ? old.page1 : [],
    page2: Array.isArray(old.page2) ? old.page2 : [],
    page3: Array.isArray(old.page3) ? old.page3 : [],

    ispage1Skip: Boolean(old.ispage1Skip || false),
    ispage2Skip: Boolean(old.ispage2Skip || false),
    ispage3Skip: Boolean(old.ispage3Skip || false),
    isProfilePicSkip: Boolean(old.isProfilePicSkip || false),

    subscription: old.subscription || undefined,
    subscriptionExpired: Boolean(old.subscriptionExpired || false),

    failedLoginAttempts: num(old.failedLoginAttempts, 0),
    lockUntil: old.lockUntil || null,

    createdAt: dt(old.createdAt, new Date()),
    updatedAt: dt(old.updatedAt, new Date()),
  };
}

function patchBrand(existing, incoming) {
  const set = {};

  if (!isNonEmpty(existing.brandId) && isNonEmpty(incoming.brandId)) set.brandId = incoming.brandId;
  if (!isNonEmpty(existing.brandName) && isNonEmpty(incoming.brandName)) set.brandName = incoming.brandName;
  if (!isNonEmpty(existing.name) && isNonEmpty(incoming.name)) set.name = incoming.name;
  if (!isNonEmpty(existing.companySize) && isNonEmpty(incoming.companySize)) set.companySize = incoming.companySize;
  if (!isNonEmpty(existing.industry) && isNonEmpty(incoming.industry)) set.industry = incoming.industry;
  if (!isNonEmpty(existing.proxyEmail) && isNonEmpty(incoming.proxyEmail)) set.proxyEmail = incoming.proxyEmail;
  if (!isNonEmpty(existing.profilePic) && isNonEmpty(incoming.profilePic)) set.profilePic = incoming.profilePic;

  if ((!Array.isArray(existing.page1) || existing.page1.length === 0) && Array.isArray(incoming.page1) && incoming.page1.length) set.page1 = incoming.page1;
  if ((!Array.isArray(existing.page2) || existing.page2.length === 0) && Array.isArray(incoming.page2) && incoming.page2.length) set.page2 = incoming.page2;
  if ((!Array.isArray(existing.page3) || existing.page3.length === 0) && Array.isArray(incoming.page3) && incoming.page3.length) set.page3 = incoming.page3;

  if (!existing.subscription && incoming.subscription) set.subscription = incoming.subscription;
  if (existing.subscriptionExpired == null && incoming.subscriptionExpired != null) set.subscriptionExpired = incoming.subscriptionExpired;

  if (!KEEP_V2_PASSWORD && (!isNonEmpty(existing.password) || !bcryptHashLike(existing.password)) && isNonEmpty(incoming.password)) {
    set.password = incoming.password;
  }

  return set;
}

function buildInfluencerFromOld(old, categoryDocs = []) {
  const categoryByNumericId = new Map(
    (categoryDocs || [])
      .filter((c) => typeof c.id === "number")
      .map((c) => [Number(c.id), c])
  );

  const topCategory =
    old?.onboarding?.categoryId != null
      ? categoryByNumericId.get(Number(old.onboarding.categoryId))
      : null;

  const languages = Array.isArray(old.languages)
    ? old.languages
        .map((l) => ({
          _id: l.languageId || undefined,
          name: trim(l.name || ""),
        }))
        .filter((l) => l.name)
    : [];

  const categories = [];
  if (topCategory) {
    categories.push({
      _id: topCategory._id,
      name: trim(topCategory.name || ""),
    });
  }

  return {
    _id: new ObjectId(),

    // temporary legacy field
    influencerId: trim(old.influencerId || ""),

    email: lower(old.email),
    name: trim(old.name || ""),
    countryId: old.countryId || null,
    countryName: trim(old.country || old.countryName || "Unknown"),

    languages,
    categories,

    password: old.password || "",

    page1: Array.isArray(old.page1) ? old.page1 : [],
    page2: Array.isArray(old.page2) ? old.page2 : [],
    page3: Array.isArray(old.page3) ? old.page3 : [],

    ispage2Skip: Boolean(old.ispage2Skip || false),
    ispage3Skip: Boolean(old.ispage3Skip || false),

    proxyEmail: lower(old.influencerAliasEmail || old.proxyEmail || ""),

    createdAt: dt(old.createdAt, new Date()),
    updatedAt: dt(old.updatedAt, new Date()),
  };
}

function patchInfluencer(existing, incoming) {
  const set = {};

  if (!isNonEmpty(existing.influencerId) && isNonEmpty(incoming.influencerId)) set.influencerId = incoming.influencerId;
  if (!isNonEmpty(existing.name) && isNonEmpty(incoming.name)) set.name = incoming.name;
  if (!existing.countryId && incoming.countryId) set.countryId = incoming.countryId;
  if (!isNonEmpty(existing.countryName) && isNonEmpty(incoming.countryName)) set.countryName = incoming.countryName;
  if ((!Array.isArray(existing.languages) || existing.languages.length === 0) && Array.isArray(incoming.languages) && incoming.languages.length) set.languages = incoming.languages;
  if ((!Array.isArray(existing.categories) || existing.categories.length === 0) && Array.isArray(incoming.categories) && incoming.categories.length) set.categories = incoming.categories;
  if ((!Array.isArray(existing.page1) || existing.page1.length === 0) && Array.isArray(incoming.page1) && incoming.page1.length) set.page1 = incoming.page1;
  if ((!Array.isArray(existing.page2) || existing.page2.length === 0) && Array.isArray(incoming.page2) && incoming.page2.length) set.page2 = incoming.page2;
  if ((!Array.isArray(existing.page3) || existing.page3.length === 0) && Array.isArray(incoming.page3) && incoming.page3.length) set.page3 = incoming.page3;
  if (!isNonEmpty(existing.proxyEmail) && isNonEmpty(incoming.proxyEmail)) set.proxyEmail = incoming.proxyEmail;

  if (!KEEP_V2_PASSWORD && (!isNonEmpty(existing.password) || !bcryptHashLike(existing.password)) && isNonEmpty(incoming.password)) {
    set.password = incoming.password;
  }

  return set;
}

function mapActor(oldActor, brandUuidToOid) {
  if (!oldActor || typeof oldActor !== "object") return null;
  const role = trim(oldActor.role).toLowerCase();

  if (role === "brand") {
    const mapped = brandUuidToOid.get(trim(oldActor.userId));
    if (!mapped) return null;
    return {
      role: "brand",
      userId: mapped,
      userModel: "Brand",
      email: "",
      name: "",
      adminRole: "",
    };
  }

  // admin mapping intentionally skipped unless you also migrate admin/master docs
  return null;
}

function mapPendingUpdate(oldPending, brandUuidToOid) {
  if (!oldPending || typeof oldPending !== "object") {
    return {
      status: "none",
      patch: null,
      updatedBy: null,
      updatedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: "",
    };
  }

  const status = ["none", "pending", "approved", "rejected"].includes(oldPending.status)
    ? oldPending.status
    : "none";

  return {
    status,
    patch: oldPending.patch ?? null,
    updatedBy: mapActor(oldPending.updatedBy, brandUuidToOid),
    updatedAt: oldPending.updatedAt || null,
    reviewedBy: mapActor(oldPending.reviewedBy, brandUuidToOid),
    reviewedAt: oldPending.reviewedAt || null,
    reviewNote: trim(oldPending.reviewNote || ""),
  };
}

function resolveCategoryMapping(oldCategories, newCategories) {
  const categoryByNumericId = new Map(
    (newCategories || [])
      .filter((c) => typeof c.id === "number")
      .map((c) => [Number(c.id), c])
  );

  const pairs = [];
  let chosenCategoryId = null;
  let chosenCategoryName = "";
  const subcategoryIds = [];

  for (const oldCat of oldCategories || []) {
    const categoryDoc = categoryByNumericId.get(Number(oldCat.categoryId));

    if (!categoryDoc) {
      pairs.push({
        categoryId: str(oldCat.categoryId || ""),
        categoryName: trim(oldCat.categoryName || ""),
        subcategoryId: str(oldCat.subcategoryId || ""),
        subcategoryName: trim(oldCat.subcategoryName || ""),
      });
      continue;
    }

    const sub = (categoryDoc.subcategories || []).find(
      (s) => lower(s.name || "") === lower(oldCat.subcategoryName || "")
    );

    if (!chosenCategoryId) {
      chosenCategoryId = categoryDoc._id;
      chosenCategoryName = trim(categoryDoc.name || "");
    }

    if (sub?._id) subcategoryIds.push(sub._id);

    pairs.push({
      categoryId: String(categoryDoc._id),
      categoryName: trim(categoryDoc.name || ""),
      subcategoryId: sub?._id ? String(sub._id) : str(oldCat.subcategoryId || ""),
      subcategoryName: trim(sub?.name || oldCat.subcategoryName || ""),
    });
  }

  return {
    categoryId: chosenCategoryId,
    categoryName: chosenCategoryName,
    subcategoryIds: uniqueBy(subcategoryIds, (x) => String(x)),
    categoryPairs: pairs,
  };
}

function resolveGoalIds(oldGoal, goalDocs) {
  const byName = new Map(
    (goalDocs || []).map((g) => [lower(g.goal || g.name || ""), g])
  );
  const goalDoc = byName.get(lower(oldGoal || ""));
  return goalDoc?._id ? [goalDoc._id] : [];
}

function resolveCountryIdsFromAudience(locations, countryDocs) {
  const byName = new Map();

  for (const c of countryDocs || []) {
    const keys = [c.countryName, c.countryNameEn, c.countryNameLocal, c.name]
      .map((x) => lower(x))
      .filter(Boolean);

    for (const k of keys) byName.set(k, c);
  }

  const ids = [];
  for (const loc of locations || []) {
    const hit = byName.get(lower(loc?.countryName || ""));
    if (hit?._id) ids.push(hit._id);
  }

  return uniqueBy(ids, (x) => String(x));
}

function buildCampaignFromOld(old, brandUuidToOid, refs) {
  const mappedBrandId = brandUuidToOid.get(trim(old.brandId));
  if (!mappedBrandId) return null;

  const primaryCategory =
    Array.isArray(old.categories) && old.categories.length ? old.categories[0] : null;

  const statusInfo = mapCampaignStatus(old);
  const mappedCategories = resolveCategoryMapping(old.categories || [], refs.categories || []);
  const goalIds = resolveGoalIds(old.goal, refs.goals || []);
  const targetCountryIds = resolveCountryIdsFromAudience(
    old?.targetAudience?.locations || [],
    refs.countries || []
  );

  return {
    _id: new ObjectId(),

    // temporary legacy field
    campaignsId: trim(old.campaignsId || ""),

    brandId: mappedBrandId,
    brandName: trim(old.brandName || ""),

    campaignTitle: trim(old.productOrServiceName || "Untitled Campaign"),
    description: trim(old.description || ""),
    campaignType: trim(old.campaignType || ""),

    campaignCategory:
      mappedCategories.categoryName ||
      trim(primaryCategory?.categoryName || old.productCategory || ""),

    campaignSubcategory:
      (mappedCategories.categoryPairs || []).map((x) => x.subcategoryName).filter(Boolean).join(", ") ||
      trim(primaryCategory?.subcategoryName || ""),

    categoryId: mappedCategories.categoryId || null,
    subcategoryIds: mappedCategories.subcategoryIds || [],

    productImages: Array.isArray(old.images) ? old.images : [],
    productLink: "",
    videoLink: "",
    productServiceInfo: Array.isArray(old.creativeBrief) ? old.creativeBrief : [],

    campaignGoals: goalIds,
    influencerTierIds: [],
    contentFormats: [],
    contentLanguageIds: [],
    preferredHashtags: [],
    targetCountryIds,
    targetAgeRanges: [],

    numberOfInfluencers: Math.max(1, num(old.noInfluencers, 1)),
    influencerTier: trim(old.influencerTier || ""),

    minFollowers: 0,
    maxFollowers: 0,

    creatorContentLanguage: "",
    audienceContentLanguage: "",
    targetCountry: Array.isArray(old?.targetAudience?.locations)
      ? old.targetAudience.locations.map((x) => x.countryName).filter(Boolean).join(", ")
      : "",

    campaignBudget: num(old.budget, 0),
    budget: num(old.budget, 0),
    influencerBudget: num(old.influencerBudget, 0),

    paymentType: "Milestone",
    platformSelection: [],

    additionalNotes: [old.additionalNotes, old.creativeBriefText].filter(Boolean).join("\n\n"),
    hashtags: [],
    campaignTimezone: "UTC",

    scheduledAt: null,
    startAt: old?.timeline?.startDate || null,
    endAt: old?.timeline?.endDate || null,
    publishedAt: statusInfo.status === "active" ? dt(old.createdAt, new Date()) : null,
    endedAt: null,

    createdLocation: null,
    scheduledLocation: null,
    draftExpiresAt:
      statusInfo.status === "draft"
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        : null,

    timeline: {
      startDate: old?.timeline?.startDate || null,
      endDate: old?.timeline?.endDate || null,
    },

    categories: mappedCategories.categoryPairs,

    status: statusInfo.status,
    publishStatus: statusInfo.publishStatus,
    approvalMode: trim(old.approvalMode || "direct"),

    statusUpdatedAt: old.statusUpdatedAt || old.updatedAt || old.createdAt || new Date(),
    pausedAt: old.pausedAt || null,

    isActive: statusInfo.isActive,
    applicantCount: num(old.applicantCount, 0),
    hasApplied: num(old.hasApplied, 0),
    isDraft: statusInfo.isDraft,
    byAi: 0,

    createdBy: mapActor(old.createdBy, brandUuidToOid),
    pendingUpdate: mapPendingUpdate(old.pendingUpdate, brandUuidToOid),

    createdAt: dt(old.createdAt, new Date()),
    updatedAt: dt(old.updatedAt, new Date()),
  };
}

function patchCampaign(existing, incoming) {
  const set = {};

  if (!isNonEmpty(existing.campaignsId) && isNonEmpty(incoming.campaignsId)) set.campaignsId = incoming.campaignsId;
  if (!isNonEmpty(existing.brandName) && isNonEmpty(incoming.brandName)) set.brandName = incoming.brandName;
  if (!isNonEmpty(existing.campaignTitle) && isNonEmpty(incoming.campaignTitle)) set.campaignTitle = incoming.campaignTitle;
  if (!isNonEmpty(existing.description) && isNonEmpty(incoming.description)) set.description = incoming.description;
  if (!isNonEmpty(existing.campaignType) && isNonEmpty(incoming.campaignType)) set.campaignType = incoming.campaignType;

  if (!existing.categoryId && incoming.categoryId) set.categoryId = incoming.categoryId;
  if ((!Array.isArray(existing.subcategoryIds) || existing.subcategoryIds.length === 0) && Array.isArray(incoming.subcategoryIds) && incoming.subcategoryIds.length) {
    set.subcategoryIds = incoming.subcategoryIds;
  }

  if ((!Array.isArray(existing.productImages) || existing.productImages.length === 0) && Array.isArray(incoming.productImages) && incoming.productImages.length) {
    set.productImages = incoming.productImages;
  }

  if (!isNonEmpty(existing.additionalNotes) && isNonEmpty(incoming.additionalNotes)) set.additionalNotes = incoming.additionalNotes;
  if ((!Array.isArray(existing.campaignGoals) || existing.campaignGoals.length === 0) && Array.isArray(incoming.campaignGoals) && incoming.campaignGoals.length) {
    set.campaignGoals = incoming.campaignGoals;
  }
  if ((!Array.isArray(existing.targetCountryIds) || existing.targetCountryIds.length === 0) && Array.isArray(incoming.targetCountryIds) && incoming.targetCountryIds.length) {
    set.targetCountryIds = incoming.targetCountryIds;
  }
  if (!isNonEmpty(existing.targetCountry) && isNonEmpty(incoming.targetCountry)) set.targetCountry = incoming.targetCountry;

  if (!isNonEmpty(existing.campaignCategory) && isNonEmpty(incoming.campaignCategory)) set.campaignCategory = incoming.campaignCategory;
  if (!isNonEmpty(existing.campaignSubcategory) && isNonEmpty(incoming.campaignSubcategory)) set.campaignSubcategory = incoming.campaignSubcategory;

  if ((!Array.isArray(existing.categories) || existing.categories.length === 0) && Array.isArray(incoming.categories) && incoming.categories.length) {
    set.categories = incoming.categories;
  }

  return set;
}

async function main() {
  if (!OLD_URI) throw new Error("OLD URI missing");
  if (!NEW_URI) throw new Error("NEW URI missing");

  const oldConn = await mongoose.createConnection(OLD_URI).asPromise();
  const newConn = await mongoose.createConnection(NEW_URI).asPromise();

  try {
    const oldDb = oldConn.db;
    const newDb = newConn.db;

    const [
      oldBrands,
      oldCampaigns,
      oldInfluencers,
      newCategories,
      newCountries,
      newGoals,
      existingBrands,
      existingCampaigns,
      existingInfluencers,
    ] = await Promise.all([
      oldDb.collection("brands").find({}).toArray(),
      oldDb.collection("campaigns").find({}).toArray(),
      oldDb.collection("influencers").find({}).toArray(),

      newDb.collection("categories").find({}).toArray().catch(() => []),
      newDb.collection("countries").find({}).toArray().catch(() => []),
      newDb.collection("productservicegoals").find({}).toArray().catch(() => []),

      newDb.collection("brands").find({}).toArray(),
      newDb.collection("campaigns").find({}).toArray(),
      newDb.collection("influencers").find({}).toArray(),
    ]);

    const brandByEmail = new Map(existingBrands.map((b) => [lower(b.email), b]));
    const brandByLegacyId = new Map(
      existingBrands.filter((b) => isNonEmpty(b.brandId)).map((b) => [trim(b.brandId), b])
    );

    const influencerByEmail = new Map(existingInfluencers.map((i) => [lower(i.email), i]));
    const influencerByLegacyId = new Map(
      existingInfluencers.filter((i) => isNonEmpty(i.influencerId)).map((i) => [trim(i.influencerId), i])
    );

    const campaignByLegacyId = new Map(
      existingCampaigns.filter((c) => isNonEmpty(c.campaignsId)).map((c) => [trim(c.campaignsId), c])
    );
    const campaignByFingerprint = new Map(
      existingCampaigns.map((c) => [campaignFingerprint(c), c])
    );

    const stats = {
      brandsInserted: 0,
      brandsMatched: 0,
      brandsPatched: 0,
      influencersInserted: 0,
      influencersMatched: 0,
      influencersPatched: 0,
      campaignsInserted: 0,
      campaignsMatched: 0,
      campaignsPatched: 0,
      conflicts: [],
    };

    // old brandId UUID -> chosen V2 _id
    const brandUuidToChosenOid = new Map();

    // ---- BRANDS ----
    for (const old of oldBrands) {
      const incoming = buildBrandFromOld(old);

      let existing =
        brandByEmail.get(incoming.email) ||
        (incoming.brandId ? brandByLegacyId.get(incoming.brandId) : null) ||
        null;

      if (existing) {
        stats.brandsMatched += 1;

        if (PATCH_EXISTING) {
          const set = patchBrand(existing, incoming);
          if (Object.keys(set).length) {
            stats.brandsPatched += 1;
            if (!DRY_RUN) {
              await newDb.collection("brands").updateOne(
                { _id: existing._id },
                { $set: set }
              );
            }
            Object.assign(existing, set);
          }
        }

        brandUuidToChosenOid.set(trim(old.brandId), existing._id);
        brandUuidToChosenOid.set(String(old._id), existing._id);
        brandByEmail.set(incoming.email, existing);
        if (incoming.brandId) brandByLegacyId.set(incoming.brandId, existing);
      } else {
        stats.brandsInserted += 1;

        if (!DRY_RUN) {
          await newDb.collection("brands").insertOne(incoming);
        }

        brandUuidToChosenOid.set(trim(old.brandId), incoming._id);
        brandUuidToChosenOid.set(String(old._id), incoming._id);
        brandByEmail.set(incoming.email, incoming);
        if (incoming.brandId) brandByLegacyId.set(incoming.brandId, incoming);
      }
    }

    // ---- INFLUENCERS ----
    for (const old of oldInfluencers) {
      const incoming = buildInfluencerFromOld(old, newCategories);

      let existing =
        influencerByEmail.get(incoming.email) ||
        (incoming.influencerId ? influencerByLegacyId.get(incoming.influencerId) : null) ||
        null;

      if (existing) {
        stats.influencersMatched += 1;

        if (PATCH_EXISTING) {
          const set = patchInfluencer(existing, incoming);
          if (Object.keys(set).length) {
            stats.influencersPatched += 1;
            if (!DRY_RUN) {
              await newDb.collection("influencers").updateOne(
                { _id: existing._id },
                { $set: set }
              );
            }
            Object.assign(existing, set);
          }
        }

        influencerByEmail.set(incoming.email, existing);
        if (incoming.influencerId) influencerByLegacyId.set(incoming.influencerId, existing);
      } else {
        stats.influencersInserted += 1;

        if (!DRY_RUN) {
          await newDb.collection("influencers").insertOne(incoming);
        }

        influencerByEmail.set(incoming.email, incoming);
        if (incoming.influencerId) influencerByLegacyId.set(incoming.influencerId, incoming);
      }
    }

    // ---- CAMPAIGNS ----
    for (const old of oldCampaigns) {
      const incoming = buildCampaignFromOld(old, brandUuidToChosenOid, {
        categories: newCategories,
        goals: newGoals,
        countries: newCountries,
      });

      if (!incoming) {
        stats.conflicts.push({
          type: "campaign_brand_unmapped",
          oldCampaignId: trim(old.campaignsId || old._id),
          oldBrandId: trim(old.brandId),
          title: trim(old.productOrServiceName || ""),
        });
        continue;
      }

      const fp = campaignFingerprint(incoming);

      let existing =
        (incoming.campaignsId ? campaignByLegacyId.get(incoming.campaignsId) : null) ||
        campaignByFingerprint.get(fp) ||
        null;

      if (existing) {
        stats.campaignsMatched += 1;

        if (PATCH_EXISTING) {
          const set = patchCampaign(existing, incoming);
          if (Object.keys(set).length) {
            stats.campaignsPatched += 1;
            if (!DRY_RUN) {
              await newDb.collection("campaigns").updateOne(
                { _id: existing._id },
                { $set: set }
              );
            }
            Object.assign(existing, set);
          }
        }

        if (incoming.campaignsId) campaignByLegacyId.set(incoming.campaignsId, existing);
        campaignByFingerprint.set(fp, existing);
      } else {
        stats.campaignsInserted += 1;

        if (!DRY_RUN) {
          await newDb.collection("campaigns").insertOne(incoming);
        }

        if (incoming.campaignsId) campaignByLegacyId.set(incoming.campaignsId, incoming);
        campaignByFingerprint.set(fp, incoming);
      }
    }

    console.log("==== MERGE RESULT ====");
    console.log(JSON.stringify(stats, null, 2));
    console.log("DRY_RUN =", DRY_RUN);
  } finally {
    await oldConn.close();
    await newConn.close();
  }
}

main().catch((err) => {
  console.error("Merge failed:", err);
  process.exit(1);
});