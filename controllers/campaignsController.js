const mongoose = require("mongoose");
const { Types } = require("mongoose");
const multer = require("multer");
const OpenAI = require("openai");
const { DateTime } = require("luxon");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { CategoryModel } = require("../models/categories");
const ApplyCampaign = require("../models/applyCampaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Contract = require("../models/contract");
const Country = require("../models/country");
const Modash = require("../models/modash");
const Admin = require("../models/admin");

const { AgeRangeModel: AgeRange } = require("../models/ageRange");
const ContentLanguage = require("../models/language");
const { InfluencerTierModel: InfluencerTier } = require("../models/influencerTier");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { ContentFormatModel: ContentFormat } = require("../models/contentFormat");
const { PreferredHashtagModel: PreferredHashtag } = require("../models/preferredHashtag");

const { CONTRACT_STATUS } = require("../constants/contract");
const { createAndEmit } = require("../utils/notifier");
const { detectGeoFromRequest } = require("../utils/ipGeo");
const { ApiResponse } = require("../core/http/ApiResponse.js");
const { HttpStatus } = require("../core/http/HttpStatus.js");

// ===============================
//  New Create / AI helpers
// ===============================

const escapeRegex = (s = "") =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const EC = (code) => code;
const getRequestId = (req) => req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const isOid = (v) => mongoose.Types.ObjectId.isValid(clean(v));
const toObjectId = (id) => new mongoose.Types.ObjectId(clean(id));
const toUnknownArray = (v) => (Array.isArray(v) ? v : []);

const toNumber = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const toInt = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : NaN;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

const clampInt = (v, def, min, max) => {
  const n = toInt(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const isValidHttpUrl = (v) => {
  const s = clean(v);
  if (!s) return false;
  try {
    const u = new URL(s);
    return /^https?:$/i.test(u.protocol);
  } catch {
    return false;
  }
};

const normalizeObjectIdArray = (v) => {
  if (Array.isArray(v)) return v.map((x) => clean(String(x))).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const s = clean(v);
  return s && mongoose.Types.ObjectId.isValid(s) ? [s] : [];
};

const fail = (res, http, code, message, requestId, meta) => {
  return ApiResponse.sendFail(res, http, EC(code), message, requestId, meta);
};

const missingRequired = (field) => `Missing required field: ${field}`;

const failField = (res, http, code, field, requestId, message) => {
  const msg = message || missingRequired(field);
  return ApiResponse.sendFail(res, http, EC(code), msg, requestId, {
    fieldErrors: { [field]: msg },
  });
};

const requireObjectId = (res, requestId, field, v) => {
  const s = clean(v);
  if (!s) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  if (!mongoose.Types.ObjectId.isValid(s)) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId, `Invalid ${field}`),
    };
  }
  return { ok: true, value: s };
};

const requireString = (res, requestId, field, v) => {
  const s = clean(v);
  if (!s) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  return { ok: true, value: s };
};

const requireIdArray = (res, requestId, field, v) => {
  const ids = normalizeObjectIdArray(v);
  if (!ids.length) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  return { ok: true, value: ids };
};

const requireArray = (res, requestId, field, v) => {
  const arr = toUnknownArray(v);
  if (!arr.length) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  return { ok: true, value: arr };
};

const normalizePaymentType = (v) => {
  const s = clean(v).toLowerCase();
  if (s === "milestone") return "Milestone";
  if (s === "fixed") return "Fixed";
  if (s === "gifting") return "Gifting";
  return s ? s[0].toUpperCase() + s.slice(1) : "Milestone";
};

const hasDateInput = (v) => (v instanceof Date ? Number.isFinite(v.getTime()) : !!clean(v));

const MIN_FOLLOWERS_ALLOWED = 1000;

const fmtInt = (n) => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? new Intl.NumberFormat("en-US").format(Math.trunc(x)) : "";
};

const sendControllerError = (res, requestId, err) => {
  const e = err;

  if (e?.code === 11000) {
    return ApiResponse.sendFail(
      res,
      HttpStatus.CONFLICT,
      EC("VALIDATION_ERROR"),
      "Duplicate record",
      requestId,
      { keyValue: e?.keyValue }
    );
  }

  if (e?.name === "CastError") {
    const field = String(e?.path || "value");
    const msg = `Invalid ${field}`;
    return ApiResponse.sendFail(
      res,
      HttpStatus.BAD_REQUEST,
      EC("VALIDATION_ERROR"),
      msg,
      requestId,
      {
        fieldErrors: { [field]: msg },
        value: e?.value,
      }
    );
  }

  if (e?.name === "ValidationError") {
    const first = Object.values(e?.errors || {})[0];
    const field = String(first?.path || "unknown");
    const fieldKey = field.replace(/\s+/g, "").toLowerCase();

    const minFromSchema = first?.properties?.min;
    let msg = String(first?.message || "Validation failed");

    if (first?.kind === "min" && (fieldKey === "minfollowers" || fieldKey === "maxfollowers")) {
      const minVal = Number.isFinite(Number(minFromSchema)) ? Number(minFromSchema) : MIN_FOLLOWERS_ALLOWED;
      msg =
        fieldKey === "minfollowers"
          ? `Min followers must be at least ${fmtInt(minVal)}.`
          : `Max followers must be at least ${fmtInt(minVal)}.`;
    }

    return ApiResponse.sendFail(
      res,
      HttpStatus.BAD_REQUEST,
      EC("VALIDATION_ERROR"),
      msg,
      requestId,
      {
        fieldErrors: { [field]: msg },
      }
    );
  }

  const message = err instanceof Error ? err.message : "Internal error";
  return ApiResponse.sendFail(
    res,
    HttpStatus.INTERNAL_SERVER_ERROR,
    EC("INTERNAL_ERROR"),
    message,
    requestId
  );
};

const pickStatus = (v) => {
  const allowed = ["draft", "scheduled", "active", "paused", "completed"];
  return typeof v === "string" && allowed.includes(v) ? v : "draft";
};

const toPlatformArray = (v) => {
  const allowed = ["youtube", "instagram", "tiktok"];
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out = raw
    .map((x) => clean(String(x)).toLowerCase())
    .filter((x) => allowed.includes(x));
  return [...new Set(out)];
};

const resolveCategoryAndSubcategories = async (categoryId, subIds) => {
  const cat = await CategoryModel.findById(categoryId)
    .select("_id name subcategories")
    .lean();

  if (!cat) return { cat: null, subs: [], error: "Category not found" };

  const allSubs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
  const subMap = new Map(allSubs.map((s) => [String(s._id), s]));

  const orderedSubs = subIds.map((id) => subMap.get(String(id))).filter(Boolean);
  if (subIds.length && orderedSubs.length !== subIds.length) {
    return { cat: null, subs: [], error: "One or more subcategories not found in this category" };
  }

  return { cat, subs: orderedSubs, error: "" };
};

const DEFAULT_CAMPAIGN_TZ = "UTC";

const normalizeTimezone = (tzRaw) => {
  const tz = clean(tzRaw) || DEFAULT_CAMPAIGN_TZ;
  const probe = DateTime.now().setZone(tz);
  return probe.isValid ? tz : DEFAULT_CAMPAIGN_TZ;
};

const getCampaignTimezone = (body, fallback) => {
  return normalizeTimezone(body?.campaignTimezone ?? body?.timezone ?? body?.tz ?? fallback ?? DEFAULT_CAMPAIGN_TZ);
};

const hasOffsetOrZ = (s) => /([zZ]|[+\-]\d{2}:\d{2})$/.test(s);

const toUtcFromLocalOrAbsolute = (dtRaw, tzRaw) => {
  const dt = clean(dtRaw);
  if (!dt) return null;

  if (hasOffsetOrZ(dt)) {
    const d = new Date(dt);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const tz = normalizeTimezone(tzRaw);
  const lx = DateTime.fromISO(dt, { zone: tz });
  return lx.isValid ? lx.toUTC().toJSDate() : null;
};

const assertNotPastUtc = (dtUtc, tz, field) => {
  const nowUtc = DateTime.utc();
  if (dtUtc.getTime() < nowUtc.toMillis()) {
    const prettyNowUtc = `${nowUtc.toFormat("yyyy-LL-dd HH:mm:ss")} UTC`;
    return {
      ok: false,
      message: `${field} cannot be in the past. Choose current/future time (${prettyNowUtc}). Timezone used for scheduling: ${normalizeTimezone(tz)}`,
      meta: {
        timezone: normalizeTimezone(tz),
        currentUtcTime: nowUtc.toISO({ suppressMilliseconds: true }),
      },
    };
  }
  return { ok: true };
};

const oidToStr = (v) => (v ? String(v) : "");
const asIdArray = (v) =>
  Array.isArray(v) ? v.map((x) => oidToStr(x)).filter((x) => mongoose.Types.ObjectId.isValid(x)) : [];

const orderByIds = (ids, docs) => {
  const map = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => map.get(id)).filter(Boolean);
};

const enrichCampaigns = async (itemsRaw) => {
  const items = itemsRaw.map((x) => (typeof x?.toObject === "function" ? x.toObject() : x));

  const categoryIds = new Set();
  const goalIds = new Set();
  const tierIds = new Set();
  const formatIds = new Set();
  const langIds = new Set();
  const countryIds = new Set();
  const ageIds = new Set();
  const prefHashtagIds = new Set();

  for (const c of items) {
    const cid = oidToStr(c.categoryId);
    if (mongoose.Types.ObjectId.isValid(cid)) categoryIds.add(cid);

    asIdArray(c.campaignGoals).forEach((id) => goalIds.add(id));
    asIdArray(c.influencerTierIds).forEach((id) => tierIds.add(id));
    asIdArray(c.contentFormats).forEach((id) => formatIds.add(id));
    asIdArray(c.contentLanguageIds).forEach((id) => langIds.add(id));
    asIdArray(c.targetCountryIds).forEach((id) => countryIds.add(id));
    asIdArray(c.targetAgeRanges).forEach((id) => ageIds.add(id));
    asIdArray(c.preferredHashtags).forEach((id) => prefHashtagIds.add(id));
  }

  const [cats, goals, tiers, formats, langs, countries, ages, prefHashtags] = await Promise.all([
    categoryIds.size
      ? CategoryModel.find({ _id: { $in: [...categoryIds].map((id) => toObjectId(id)) } })
        .select("_id name subcategories")
        .lean()
      : Promise.resolve([]),

    goalIds.size
      ? ProductServiceGoalModel.find({ _id: { $in: [...goalIds].map((id) => toObjectId(id)) } })
        .select("_id goal sortOrder isActive")
        .lean()
      : Promise.resolve([]),

    tierIds.size
      ? InfluencerTier.find({ _id: { $in: [...tierIds].map((id) => toObjectId(id)) } })
        .select("_id category value sortOrder")
        .lean()
      : Promise.resolve([]),

    formatIds.size
      ? ContentFormat.find({ _id: { $in: [...formatIds].map((id) => toObjectId(id)) } }).lean()
      : Promise.resolve([]),

    langIds.size
      ? ContentLanguage.find({ _id: { $in: [...langIds].map((id) => toObjectId(id)) } })
        .select("_id code name isActive")
        .lean()
      : Promise.resolve([]),

    countryIds.size
      ? Country.find({ _id: { $in: [...countryIds].map((id) => toObjectId(id)) } })
        .select("_id countryNameEn countryNameLocal countryName name countryCode currencyCode currencyNameEn region flag")
        .lean()
      : Promise.resolve([]),

    ageIds.size
      ? AgeRange.find({ _id: { $in: [...ageIds].map((id) => toObjectId(id)) } }).select("_id range").lean()
      : Promise.resolve([]),

    prefHashtagIds.size
      ? PreferredHashtag.find({ _id: { $in: [...prefHashtagIds].map((id) => toObjectId(id)) } }).lean()
      : Promise.resolve([]),
  ]);

  const catMap = new Map(cats.map((d) => [String(d._id), d]));
  const goalMap = new Map(goals.map((d) => [String(d._id), d]));
  const tierMap = new Map(tiers.map((d) => [String(d._id), d]));
  const formatMap = new Map(formats.map((d) => [String(d._id), d]));
  const langMap = new Map(langs.map((d) => [String(d._id), d]));
  const countryMap = new Map(countries.map((d) => [String(d._id), d]));
  const ageMap = new Map(ages.map((d) => [String(d._id), d]));
  const prefMap = new Map(prefHashtags.map((d) => [String(d._id), d]));

  return items.map((c) => {
    const categoryId = oidToStr(c.categoryId);
    const cat = mongoose.Types.ObjectId.isValid(categoryId) ? catMap.get(categoryId) : null;

    const subIds = asIdArray(c.subcategoryIds);
    const subDetails =
      cat && Array.isArray(cat.subcategories)
        ? orderByIds(
          subIds,
          cat.subcategories.map((s) => ({ ...s, _id: String(s._id) }))
        ).map((s) => ({ id: String(s._id), name: s.name, tags: s.tags ?? [] }))
        : [];

    const goalDetails = asIdArray(c.campaignGoals)
      .map((id) => goalMap.get(id))
      .filter(Boolean)
      .map((g) => ({ id: String(g._id), goal: g.goal, sortOrder: g.sortOrder, isActive: g.isActive }));

    const tierDetails = asIdArray(c.influencerTierIds)
      .map((id) => tierMap.get(id))
      .filter(Boolean)
      .map((t) => ({ id: String(t._id), category: t.category, value: t.value, sortOrder: t.sortOrder }));

    const formatDetails = asIdArray(c.contentFormats)
      .map((id) => formatMap.get(id))
      .filter(Boolean)
      .map((f) => ({ id: String(f._id), ...f, _id: undefined }));

    const langDetails = asIdArray(c.contentLanguageIds)
      .map((id) => langMap.get(id))
      .filter(Boolean)
      .map((l) => ({ id: String(l._id), code: l.code, name: l.name, isActive: l.isActive }));

    const countryDetails = asIdArray(c.targetCountryIds)
      .map((id) => countryMap.get(id))
      .filter(Boolean)
      .map((x) => ({ id: String(x._id), ...x, _id: undefined }));

    const ageDetails = asIdArray(c.targetAgeRanges)
      .map((id) => ageMap.get(id))
      .filter(Boolean)
      .map((a) => ({ id: String(a._id), range: a.range }));

    const prefDetails = asIdArray(c.preferredHashtags)
      .map((id) => prefMap.get(id))
      .filter(Boolean)
      .map((h) => ({ id: String(h._id), ...h, _id: undefined }));

    return {
      ...c,
      id: String(c._id || c.id || ""),
      details: {
        category: cat ? { id: String(cat._id), name: cat.name } : null,
        subcategories: subDetails,
        campaignGoals: goalDetails,
        influencerTiers: tierDetails,
        contentFormats: formatDetails,
        contentLanguages: langDetails,
        targetCountries: countryDetails,
        targetAgeRanges: ageDetails,
        preferredHashtags: prefDetails,
      },
    };
  });
};

const buildCampaignLookupFilter = (campaignId, brandObjectId) => {
  const raw = clean(campaignId);
  const or = [{ campaignsId: raw }];

  if (mongoose.Types.ObjectId.isValid(raw)) {
    or.push({ _id: toObjectId(raw) });
  }

  const filter = { $or: or };
  if (brandObjectId) filter.brandId = brandObjectId;
  return filter;
};

const parseCampaignWindowForUpdate = (body, tz, requestId, res, opts = {}) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);

  if (!startAtUtc) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId),
    };
  }

  if (!endAtUtc) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId),
    };
  }

  if (startAtUtc.getTime() >= endAtUtc.getTime()) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "endAt",
        requestId,
        "startAt must be < endAt"
      ),
    };
  }

  if (!opts.allowPastStart) {
    const c1 = assertNotPastUtc(startAtUtc, tz, "startAt");
    if (!c1.ok) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId, c1.message),
      };
    }
  }

  const c2 = assertNotPastUtc(endAtUtc, tz, "endAt");
  if (!c2.ok) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, c2.message),
    };
  }

  return { ok: true, value: { startAt: startAtUtc, endAt: endAtUtc } };
};

const buildCampaignUpdatePatch = (body, existing, status, timing, extra = {}) => {
  const budget = toNumber(body.campaignBudget);
  const numInfluencers = toInt(body.numberOfInfluencers);
  const minFollowers = toInt(body.minFollowers);
  const maxFollowers = toInt(body.maxFollowers);

  const toOidOrFallback = (value, fallback) => {
    const s = clean(value);
    return s && isOid(s) ? toObjectId(s) : fallback;
  };

  const toOidArrayOrFallback = (value, fallback = []) => {
    const arr = normalizeObjectIdArray(value).map((x) => toObjectId(x));
    return arr.length ? arr : fallback;
  };

  const patch = {
    campaignTitle: clean(body.campaignTitle) || existing.campaignTitle,
    productOrServiceName: clean(body.campaignTitle) || existing.productOrServiceName,

    description: clean(body.description) || existing.description,
    campaignType: clean(body.campaignType) || existing.campaignType || "",

    categoryId: toOidOrFallback(body.categoryId, existing.categoryId),
    subcategoryIds: toOidArrayOrFallback(body.subcategoryIds, existing.subcategoryIds || []),

    productImages: toUnknownArray(body.productImages).length
      ? toUnknownArray(body.productImages)
      : toUnknownArray(existing.productImages || existing.images),

    images: toUnknownArray(body.productImages).length
      ? toUnknownArray(body.productImages)
      : toUnknownArray(existing.images || existing.productImages),

    productLink: clean(body.productLink),
    videoLink: clean(body.videoLink),

    campaignGoals: toOidArrayOrFallback(body.campaignGoals, existing.campaignGoals || []),
    influencerTierIds: toOidArrayOrFallback(body.influencerTierIds, existing.influencerTierIds || []),
    contentFormats: toOidArrayOrFallback(body.contentFormats, existing.contentFormats || []),
    contentLanguageIds: toOidArrayOrFallback(body.contentLanguageIds, existing.contentLanguageIds || []),
    preferredHashtags: toOidArrayOrFallback(body.preferredHashtags, existing.preferredHashtags || []),

    platformSelection: toPlatformArray(body.platformSelection),
    targetCountryIds: toOidArrayOrFallback(body.targetCountryIds, existing.targetCountryIds || []),
    targetAgeRanges: toOidArrayOrFallback(body.targetAgeRanges, existing.targetAgeRanges || []),

    paymentType: clean(body.paymentType)
      ? normalizePaymentType(body.paymentType)
      : existing.paymentType,

    campaignBudget: Number.isFinite(budget) ? budget : existing.campaignBudget,
    budget: Number.isFinite(budget) ? budget : existing.budget,

    numberOfInfluencers: Number.isFinite(numInfluencers)
      ? numInfluencers
      : existing.numberOfInfluencers,

    minFollowers:
      Number.isFinite(minFollowers) && minFollowers > 0
        ? minFollowers
        : existing.minFollowers,

    maxFollowers:
      Number.isFinite(maxFollowers) && maxFollowers > 0
        ? maxFollowers
        : existing.maxFollowers,

    additionalNotes: clean(body.additionalNotes),

    status,
    campaignTimezone: clean(body.campaignTimezone) || existing.campaignTimezone || DEFAULT_CAMPAIGN_TZ,

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : status === "scheduled" ? "scheduled" : "published",
    campaignStatus: status === "active" ? "open" : existing.campaignStatus || "paused",
    statusUpdatedAt: new Date(),
  };

  if (extra.categoryName) {
    patch.campaignCategory = extra.categoryName;
  }

  if (Array.isArray(extra.subcategoryNames) && extra.subcategoryNames.length) {
    patch.campaignSubcategory = extra.subcategoryNames.join(", ");
    patch.categories = extra.subcategoryNames.map((subName, idx) => ({
      categoryId: String(body.categoryId || existing.categoryId || ""),
      categoryName: extra.categoryName || "",
      subcategoryId: String(normalizeObjectIdArray(body.subcategoryIds)[idx] || ""),
      subcategoryName: subName,
    }));
  }

  if (timing?.startAt) patch.startAt = timing.startAt;
  if (timing?.endAt) patch.endAt = timing.endAt;

  patch.timeline = {
    startDate: timing?.startAt || existing.startAt || existing.timeline?.startDate,
    endDate: timing?.endAt || existing.endAt || existing.timeline?.endDate,
  };

  if (status === "active") {
    patch.publishedAt = existing.publishedAt || new Date();
    patch.scheduledAt = undefined;
    patch.scheduledLocation = undefined;
  }

  if (status === "draft") {
    patch.publishedAt = undefined;
    patch.scheduledAt = undefined;
    patch.scheduledLocation = undefined;
  }

  if (status === "scheduled") {
    patch.scheduledAt = timing?.scheduledAt;
    patch.scheduledLocation = existing.createdLocation;
  }

  return patch;
};

const toUtcDateFromAny = (v, tz) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const s = clean(v);
  return s ? toUtcFromLocalOrAbsolute(s, tz) : null;
};

const parseCampaignWindow = (body, tz, requestId, res, required) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);

  if (!required && !body.startAt && !body.endAt) return { ok: true, value: {} };

  if (!startAtUtc) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId) };
  }
  if (!endAtUtc) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId) };
  }

  if (startAtUtc.getTime() >= endAtUtc.getTime()) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "endAt",
        requestId,
        "startAt must be < endAt"
      ),
    };
  }

  const c1 = assertNotPastUtc(startAtUtc, tz, "startAt");
  if (!c1.ok) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId, c1.message) };
  }

  const c2 = assertNotPastUtc(endAtUtc, tz, "endAt");
  if (!c2.ok) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, c2.message) };
  }

  return { ok: true, value: { startAt: startAtUtc, endAt: endAtUtc } };
};

const inferMode = (statusRaw, scheduledAt) => {
  if (clean(scheduledAt)) return "schedule";
  const statusStr = clean(statusRaw);
  if (!statusStr) return "publish";

  const status = pickStatus(statusRaw);
  if (status === "draft") return "draft";
  if (status === "scheduled") return "schedule";
  return "publish";
};

const validateForMode = async (res, requestId, mode, body, opts = {}) => {
  const brandIdR = requireObjectId(res, requestId, "brandId", body.brandId);
  if (!brandIdR.ok) return { ok: false, resp: brandIdR.resp };

  const titleR = requireString(res, requestId, "campaignTitle", body.campaignTitle);
  if (!titleR.ok) return { ok: false, resp: titleR.resp };

  if (mode === "draft") {
    return {
      ok: true,
      brandId: brandIdR.value,
      rel: null,
      normalized: {
        platformSelection: toPlatformArray(body.platformSelection),
        paymentType: clean(body.paymentType) ? normalizePaymentType(body.paymentType) : undefined,
      },
    };
  }

  const descR = requireString(res, requestId, "description", body.description);
  if (!descR.ok) return { ok: false, resp: descR.resp };

  const catR = requireObjectId(res, requestId, "categoryId", body.categoryId);
  if (!catR.ok) return { ok: false, resp: catR.resp };

  const subIds = normalizeObjectIdArray(body.subcategoryIds);
  if (!subIds.length) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId) };
  }

  const rel = await resolveCategoryAndSubcategories(catR.value, subIds);
  if (rel.error) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId, rel.error),
    };
  }

  const existingProductImages = toUnknownArray(opts.existingProductImages);
  const incomingProductImages = toUnknownArray(body.productImages);

  if (mode !== "draft" && !incomingProductImages.length && !existingProductImages.length) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "productImages", requestId),
    };
  }

  const link = clean(body.productLink);
  if (link && !isValidHttpUrl(link)) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "productLink",
        requestId,
        "productLink must be a valid http/https URL"
      ),
    };
  }

  const minFollowersRaw = clean(body.minFollowers);
  const maxFollowersRaw = clean(body.maxFollowers);

  let minFollowers = null;

  if (minFollowersRaw) {
    const n = toInt(body.minFollowers);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        resp: failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "minFollowers",
          requestId,
          "Min followers must be a number."
        ),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "minFollowers",
          requestId,
          `Min followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`
        ),
      };
    }
    minFollowers = n;
  }

  if (maxFollowersRaw) {
    const n = toInt(body.maxFollowers);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        resp: failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "maxFollowers",
          requestId,
          "Max followers must be a number."
        ),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "maxFollowers",
          requestId,
          `Max followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`
        ),
      };
    }
    if (typeof minFollowers === "number" && n < minFollowers) {
      return {
        ok: false,
        resp: failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "maxFollowers",
          requestId,
          "Max followers must be greater than or equal to min followers."
        ),
      };
    }
  }

  const videoLink = clean(body.videoLink);
  if (videoLink && !isValidHttpUrl(videoLink)) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "videoLink",
        requestId,
        "videoLink must be a valid http/https URL"
      ),
    };
  }

  const goalsR = requireIdArray(res, requestId, "campaignGoals", body.campaignGoals);
  if (!goalsR.ok) return { ok: false, resp: goalsR.resp };

  const tiersR = requireIdArray(res, requestId, "influencerTierIds", body.influencerTierIds);
  if (!tiersR.ok) return { ok: false, resp: tiersR.resp };

  const formatsR = requireIdArray(res, requestId, "contentFormats", body.contentFormats);
  if (!formatsR.ok) return { ok: false, resp: formatsR.resp };

  const payR = requireString(res, requestId, "paymentType", body.paymentType);
  if (!payR.ok) return { ok: false, resp: payR.resp };

  const budget = toNumber(body.campaignBudget);
  if (!Number.isFinite(budget) || budget < 0) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "campaignBudget",
        requestId,
        "campaignBudget must be >= 0"
      ),
    };
  }

  const ps = toPlatformArray(body.platformSelection);
  if (!ps.length) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "platformSelection", requestId),
    };
  }

  const countriesR = requireIdArray(res, requestId, "targetCountryIds", body.targetCountryIds);
  if (!countriesR.ok) return { ok: false, resp: countriesR.resp };

  const agesR = requireIdArray(res, requestId, "targetAgeRanges", body.targetAgeRanges);
  if (!agesR.ok) return { ok: false, resp: agesR.resp };

  if (!hasDateInput(body.startAt)) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId),
    };
  }
  if (!hasDateInput(body.endAt)) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId),
    };
  }

  if (mode === "schedule") {
    if (!hasDateInput(body.scheduledAt)) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "scheduledAt", requestId),
      };
    }
  }

  return {
    ok: true,
    brandId: brandIdR.value,
    rel,
    normalized: {
      platformSelection: toPlatformArray(body.platformSelection),
      paymentType: normalizePaymentType(body.paymentType),
    },
  };
};

const parseDraftWindowSoft = (body, tz) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);
  if (!startAtUtc || !endAtUtc) return {};
  if (startAtUtc.getTime() >= endAtUtc.getTime()) return {};
  return { startAt: startAtUtc, endAt: endAtUtc };
};

const parseSchedule = (body, tz, requestId, res) => {
  const scheduledAtStr = clean(body.scheduledAt);
  if (!scheduledAtStr) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "scheduledAt", requestId),
    };
  }

  const scheduledAtUtc = toUtcFromLocalOrAbsolute(scheduledAtStr, tz);
  if (!scheduledAtUtc) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        "Invalid scheduledAt format"
      ),
    };
  }

  const chk = assertNotPastUtc(scheduledAtUtc, tz, "scheduledAt");
  if (!chk.ok) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "scheduledAt", requestId, chk.message),
    };
  }

  const win = parseCampaignWindow(body, tz, requestId, res, true);
  if (!win.ok) return win;

  const startRaw = clean(body.startAt);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(startRaw);

  const startLimitUtc = isDateOnly
    ? DateTime.fromISO(startRaw, { zone: normalizeTimezone(tz) }).endOf("day").toUTC().toJSDate()
    : win.value.startAt;

  if (scheduledAtUtc.getTime() > startLimitUtc.getTime()) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        "scheduledAt must be <= startAt"
      ),
    };
  }

  return {
    ok: true,
    value: { scheduledAt: scheduledAtUtc, startAt: win.value.startAt, endAt: win.value.endAt },
  };
};

const findBrandDocByAnyId = async (brandId) => {
  const s = clean(brandId);
  if (!s) return null;

  let brand = null;

  if (mongoose.Types.ObjectId.isValid(s)) {
    brand = await Brand.findById(s).lean();
  }

  if (!brand) {
    brand = await Brand.findOne({ brandId: s }).lean();
  }

  return brand;
};

const getCampaignDisplayName = (campaign) =>
  String(campaign?.campaignTitle || campaign?.productOrServiceName || "Campaign").trim();

function campaignIdFilter(campaignId) {
  const oid = toCampaignObjectId(campaignId);
  return oid ? { campaignId: String(oid) } : { campaignId: null };
}

const getCampaignEntityId = (campaign) => String(campaign?._id || "");

const toCampaignObjectId = (campaignId) => {
  const id = clean(campaignId);
  return isOid(id) ? toObjectId(id) : null;
};

const toCampaignObjectIds = (ids = []) =>
  ids.map((id) => clean(String(id))).filter(isOid).map(toObjectId);

const buildCampaignDoc = (body, geo, status, byAi, timing, extra = {}) => {
  const isDraft = status === "draft";

  const oid = (v) => {
    const s = clean(v);
    return s && isOid(s) ? toObjectId(s) : undefined;
  };

  const oidArray = (v) =>
    normalizeObjectIdArray(v)
      .filter((x) => isOid(x))
      .map((x) => toObjectId(x));

  const oidArrayOrUndef = (v) => {
    const arr = oidArray(v);
    return arr.length ? arr : undefined;
  };

  const arrOrUndef = (v) => {
    const arr = toUnknownArray(v);
    return arr.length ? arr : undefined;
  };

  const strOrUndef = (v) => {
    const s = clean(v);
    return s ? s : undefined;
  };

  const budget = toNumber(body.campaignBudget);
  const numInfluencers = toInt(body.numberOfInfluencers);
  const minFollowers = toInt(body.minFollowers);
  const maxFollowers = toInt(body.maxFollowers);

  const base = {
    brandId: toObjectId(body.brandId),
    brandName: clean(extra.brandName) || "",
    byAi,

    createdLocation: {
      ip: geo?.ip,
      timezone: geo?.timezone,
      country: geo?.country,
      state: geo?.state,
      city: geo?.city,
      latitude: typeof geo?.latitude === "number" ? geo.latitude : undefined,
      longitude: typeof geo?.longitude === "number" ? geo.longitude : undefined,
      source: geo?.source,
    },

    createdBy: extra.createdBy || null,
    approvalMode: extra.approvalMode || "direct",

    status,
    campaignTimezone: clean(body.campaignTimezone) || undefined,

    campaignTitle: clean(body.campaignTitle),
    description: isDraft ? strOrUndef(body.description) : clean(body.description),
    campaignType: isDraft ? strOrUndef(body.campaignType) : clean(body.campaignType) || "",

    categoryId: oid(body.categoryId),
    subcategoryIds: isDraft ? oidArrayOrUndef(body.subcategoryIds) : oidArray(body.subcategoryIds),

    productImages: isDraft ? arrOrUndef(body.productImages) : toUnknownArray(body.productImages),
    productLink: strOrUndef(body.productLink),
    videoLink: strOrUndef(body.videoLink),

    campaignGoals: isDraft ? oidArrayOrUndef(body.campaignGoals) : oidArray(body.campaignGoals),
    influencerTierIds: isDraft ? oidArrayOrUndef(body.influencerTierIds) : oidArray(body.influencerTierIds),
    contentFormats: isDraft ? oidArrayOrUndef(body.contentFormats) : oidArray(body.contentFormats),

    contentLanguageIds: oidArrayOrUndef(body.contentLanguageIds),
    preferredHashtags: oidArrayOrUndef(body.preferredHashtags),

    platformSelection: (() => {
      const ps = toPlatformArray(body.platformSelection);
      return isDraft ? (ps.length ? ps : undefined) : ps;
    })(),

    targetCountryIds: isDraft ? oidArrayOrUndef(body.targetCountryIds) : oidArray(body.targetCountryIds),
    targetAgeRanges: isDraft ? oidArrayOrUndef(body.targetAgeRanges) : oidArray(body.targetAgeRanges),

    paymentType: clean(body.paymentType) ? normalizePaymentType(body.paymentType) : undefined,
    campaignBudget: Number.isFinite(budget) ? budget : undefined,
    numberOfInfluencers: Number.isFinite(numInfluencers) ? numInfluencers : undefined,
    minFollowers: Number.isFinite(minFollowers) ? minFollowers : undefined,
    maxFollowers: Number.isFinite(maxFollowers) ? maxFollowers : undefined,

    additionalNotes: isDraft ? strOrUndef(body.additionalNotes) : clean(body.additionalNotes) || "",

    // compatibility fields for your unchanged APIs
    productOrServiceName: clean(body.campaignTitle),
    images: toUnknownArray(body.productImages),
    budget: Number.isFinite(budget) ? budget : 0,
    influencerBudget: Number.isFinite(toNumber(body.influencerBudget)) ? toNumber(body.influencerBudget) : 0,

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : status === "scheduled" ? "scheduled" : "published",
    campaignStatus: status === "active" ? "open" : "paused",
    statusUpdatedAt: new Date(),
  };

  if (extra.categoryName) {
    base.campaignCategory = extra.categoryName;
  }
  if (Array.isArray(extra.subcategoryNames) && extra.subcategoryNames.length) {
    base.campaignSubcategory = extra.subcategoryNames.join(", ");
    base.categories = extra.subcategoryNames.map((subName, idx) => ({
      categoryId: String(body.categoryId),
      categoryName: extra.categoryName || "",
      subcategoryId: String(normalizeObjectIdArray(body.subcategoryIds)[idx] || ""),
      subcategoryName: subName,
    }));
  }

  if (timing?.startAt) base.startAt = timing.startAt;
  if (timing?.endAt) base.endAt = timing.endAt;

  if (timing?.startAt || timing?.endAt) {
    base.timeline = {
      startDate: timing?.startAt,
      endDate: timing?.endAt,
    };
  }

  if (status === "active") base.publishedAt = new Date();

  if (status === "draft") {
    base.publishedAt = undefined;
    base.scheduledAt = undefined;
    base.scheduledLocation = undefined;
  }

  if (status === "scheduled") {
    base.scheduledAt = timing?.scheduledAt;
    base.scheduledLocation = base.createdLocation;
    base.publishedAt = undefined;
  }

  return base;
};

const notifyMatchingInfluencersForNewCampaign = async (campaignDoc, subIds = []) => {
  try {
    if (!Array.isArray(subIds) || !subIds.length) return;

    const influencers = await findMatchingInfluencers({ subIds, catNumIds: [] });
    if (!Array.isArray(influencers) || !influencers.length) return;

    const entityId = getCampaignEntityId(campaignDoc);
    const title = getCampaignDisplayName(campaignDoc);

    await Promise.all(
      influencers.map((inf) =>
        createAndEmit({
          influencerId: String(inf.influencerId),
          type: "campaign.match",
          title: "New campaign matches your profile",
          message: `${campaignDoc.brandName || "A brand"} posted "${title}".`,
          entityType: "campaign",
          entityId,
          actionPath: `/influencer/dashboard/view-campaign?id=${entityId}`,
        }).catch(() => null)
      )
    );
  } catch (e) {
    console.warn("notifyMatchingInfluencersForNewCampaign failed:", e?.message || e);
  }
};

const buildAIPrompt = (ui) => `
You are an expert campaign strategist for influencer marketing.
Your job: infer missing MANUAL form fields from the given Please Fill the Required Fields.

STRICT RULES:
- Output MUST be ONLY valid JSON (no markdown, no explanations).
- DO NOT change any source IDs (categoryId, subcategoryIds, targetCountryIds, targetAgeRanges).
- For fields that require IDs, you MUST pick IDs ONLY from allowedOptions lists.
- Always include ALL JSON keys listed in "Output JSON keys".
- If unsure, pick reasonable defaults.

REQUIRED MANUAL FIELDS TO FILL:
- campaignGoals (>=1)
- influencerTierIds (>=1)
- contentFormats (>=1)
- platformSelection (>=1) only from: youtube, instagram, tiktok
- paymentType one of: Milestone, Fixed, Gifting
- campaignBudget >= 0 (integer)
- numberOfInfluencers >= 1 (integer)
- startAt / endAt: ISO local datetime WITHOUT timezone offset. Example: "2026-02-04T09:00"
  Ensure endAt > startAt. Prefer startAt tomorrow 09:00 and endAt 7-14 days later.

OPTIONAL FIELDS (may be empty):
- minFollowers
- maxFollowers
- contentLanguageIds
- preferredHashtags
- additionalNotes
- campaignType

DESCRIPTION ENHANCEMENT:
- Create an improved, brand-friendly, clear, polished "enhancedDescription" using the source description.
- Keep it concise, structured, and suitable for influencers.

Output JSON keys (ALL of these must exist, even if empty arrays/blank strings):
enhancedTitle,
enhancedDescription,
campaignGoals,
influencerTierIds,
contentFormats,
contentLanguageIds,
preferredHashtags,
platformSelection,
paymentType,
campaignBudget,
numberOfInfluencers,
minFollowers,
maxFollowers,
startAt,
endAt,
additionalNotes

INPUT:
${JSON.stringify(ui, null, 2)}
`.trim();

// ===============================
//  Existing helpers below
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
  const title = getCampaignDisplayName(campaign);
  const entityId = getCampaignEntityId(campaign);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.draft_review",
    title: "Review your new campaign draft",
    message: `Admin has drafted "${title}". Please review and confirm.`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/review-campaigns/view?id=${entityId}` },
  });
}

async function notifyAdminBrandConfirmed(campaign) {
  const admins = await Admin.find({}, "adminId").lean();
  const adminIds = admins.map((a) => String(a.adminId || "").trim()).filter(Boolean);
  const title = getCampaignDisplayName(campaign);
  const entityId = getCampaignEntityId(campaign);

  return createAndEmit({
    adminIds,
    type: "campaign.brand_confirmed",
    title: "Brand confirmed campaign readiness",
    message: `${campaign.brandName || "Brand"} has reviewed and confirmed "${title}". It is ready to be published.`,
    entityType: "campaign",
    entityId,
    actionPath: { admin: `/admin/campaigns/view?id=${entityId}` },
  });
}

async function notifyAdminsCampaignPending(campaign, patch = null) {
  const admins = await Admin.find({}, "adminId").lean();
  const adminIds = (admins || []).map((a) => String(a.adminId || "").trim()).filter(Boolean);
  const title = getCampaignDisplayName(campaign);
  const entityId = getCampaignEntityId(campaign);

  const changedKeys = patch ? Object.keys(patch) : [];
  const changedText = changedKeys.length
    ? ` Changes: ${changedKeys.slice(0, 8).join(", ")}${changedKeys.length > 8 ? "..." : ""}`
    : "";

  return createAndEmit({
    adminIds,
    type: "campaign.pending_update",
    title: "Campaign updated (needs approval)",
    message: `${campaign.brandName || "Brand"} updated "${title}".${changedText}`,
    entityType: "campaign",
    entityId,
    actionPath: { admin: `/admin/campaigns/view?id=${entityId}` },
  });
}

async function notifyBrandApproved(campaign) {
  const title = getCampaignDisplayName(campaign);
  const entityId = getCampaignEntityId(campaign);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_approved",
    title: "Campaign update approved",
    message: `Admin approved changes for "${title}".`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${entityId}` },
  });
}

async function notifyBrandRejected(campaign, note) {
  const title = getCampaignDisplayName(campaign);
  const entityId = getCampaignEntityId(campaign);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_rejected",
    title: "Campaign update rejected",
    message: `Admin rejected changes for "${title}". ${note ? `Reason: ${note}` : ""}`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${entityId}` },
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
  limits: { fileSize: 10 * 1024 * 1024 },
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

  const cats = await CategoryModel.find({ id: { $in: catNums } }, 'id name subcategories').lean();
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
  const rows = await CategoryModel.find({}, "_id subcategories").lean();
  const subIdToParentNum = new Map();

  for (const r of rows) {
    for (const s of r.subcategories || []) {
      subIdToParentNum.set(String(s._id), String(r._id));
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

// =======================================================
// UPDATED CREATE CAMPAIGN
// =======================================================
exports.createCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const geo = await detectGeoFromRequest(req);
    const campaignTz = getCampaignTimezone(req.body);

    const brandDoc = await findBrandDocByAnyId(req.body.brandId);
    if (!brandDoc) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Brand not found", requestId);
    }

    const actor = await resolveActorFromPayload(
      req,
      String(brandDoc.brandId || brandDoc._id || req.body.brandId || "")
    );

    const mode = inferMode(req.body.status, req.body.scheduledAt);
    const v = await validateForMode(res, requestId, mode, req.body);
    if (!v.ok) return v.resp;

    const status =
      mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "active";

    let timing = {};

    if (status === "draft") {
      timing = parseDraftWindowSoft(req.body, campaignTz);
    } else if (status === "scheduled") {
      const sch = parseSchedule(req.body, campaignTz, requestId, res);
      if (!sch.ok) return sch.resp;
      timing = sch.value;
    } else {
      const win = parseCampaignWindow(req.body, campaignTz, requestId, res, true);
      if (!win.ok) return win.resp;
      timing = win.value;
    }

    req.body.campaignTimezone = campaignTz;

    const docToCreate = buildCampaignDoc(
      req.body,
      geo,
      status,
      0,
      timing,
      {
        brandName: String(brandDoc.name || brandDoc.brandName || ""),
        createdBy: actor,
        approvalMode: actor.role === "admin" ? "admin_review" : "direct",
        categoryName: v?.rel?.cat?.name || "",
        subcategoryNames: Array.isArray(v?.rel?.subs)
          ? v.rel.subs.map((s) => String(s.name || ""))
          : [],
      }
    );

    const created = await Campaign.create(docToCreate);

    if (status === "draft" && actor.role === "admin") {
      await notifyBrandDraftReady(created).catch(console.error);
    }

    if (status === "active") {
      await notifyMatchingInfluencersForNewCampaign(
        { ...created.toObject(), brandName: String(brandDoc.name || brandDoc.brandName || "") },
        normalizeObjectIdArray(req.body.subcategoryIds)
      );
    }

    const enriched = (await enrichCampaigns([created]))[0];

    return ApiResponse.sendOk(res, HttpStatus.CREATED, { doc: enriched }, requestId);
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

// =======================================================
// NEW AI PREFILL CAMPAIGN
// =======================================================
exports.prefillCampaignWithAI = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const geo = await detectGeoFromRequest(req);
    const tz = getCampaignTimezone(req.body);
    const nowLocal = DateTime.now().setZone(tz);

    const brandDoc = await findBrandDocByAnyId(req.body.brandId);
    if (!brandDoc) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Brand not found", requestId);
    }

    const actor = await resolveActorFromPayload(
      req,
      String(brandDoc.brandId || brandDoc._id || req.body.brandId || "")
    );

    const brandIdR = requireObjectId(res, requestId, "brandId", req.body.brandId);
    if (!brandIdR.ok) return brandIdR.resp;

    const titleR = requireString(res, requestId, "campaignTitle", req.body.campaignTitle);
    if (!titleR.ok) return titleR.resp;

    const descR = requireString(res, requestId, "description", req.body.description);
    if (!descR.ok) return descR.resp;

    const catR = requireObjectId(res, requestId, "categoryId", req.body.categoryId);
    if (!catR.ok) return catR.resp;

    const subR = requireIdArray(res, requestId, "subcategoryIds", req.body.subcategoryIds);
    if (!subR.ok) return subR.resp;

    const countryR = requireIdArray(res, requestId, "targetCountryIds", req.body.targetCountryIds);
    if (!countryR.ok) return countryR.resp;

    const ageR = requireIdArray(res, requestId, "targetAgeRanges", req.body.targetAgeRanges);
    if (!ageR.ok) return ageR.resp;

    const imgs = toUnknownArray(req.body.productImages);
    if (!imgs.length) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "productImages", requestId);
    }

    const productLink = clean(req.body.productLink);
    if (productLink && !isValidHttpUrl(productLink)) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "productLink",
        requestId,
        "productLink must be a valid http/https URL"
      );
    }

    const videoLink = clean(req.body.videoLink);
    if (videoLink && !isValidHttpUrl(videoLink)) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "videoLink",
        requestId,
        "videoLink must be a valid http/https URL"
      );
    }

    const rel = await resolveCategoryAndSubcategories(catR.value, subR.value);
    if (rel.error) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", rel.error, requestId);
    }

    const prefillDetails = {
      category: rel.cat ? { id: String(rel.cat._id), name: String(rel.cat.name || "") } : null,
      subcategories: (rel.subs || []).map((s) => ({
        id: String(s._id),
        name: String(s.name || ""),
        tags: s.tags ?? [],
      })),
    };

    const [goals, tiers, formats, langs] = await Promise.all([
      ProductServiceGoalModel.find({ isActive: true }).select("_id goal").lean().limit(120),
      InfluencerTier.find({}).select("_id category value sortOrder").lean().limit(120),
      ContentFormat.find({}).select("_id name title type format").lean().limit(200),
      ContentLanguage.find({ isActive: true }).select("_id code name").lean().limit(200),
    ]);

    const prefHashtagsDocs = await PreferredHashtag.find({
      subcategoryId: { $in: subR.value.map((x) => toObjectId(x)) },
    })
      .select("_id hashtag tag name")
      .lean()
      .limit(300);

    const allowed = {
      campaignGoals: goals.map((g) => ({ id: String(g._id), label: String(g.goal ?? "") })),
      influencerTiers: tiers.map((t) => ({
        id: String(t._id),
        label: [t.category, t.value].filter(Boolean).join(" ").trim(),
      })),
      contentFormats: formats.map((f) => ({
        id: String(f._id),
        label: String(f.name ?? f.title ?? f.type ?? f.format ?? ""),
      })),
      contentLanguages: langs.map((l) => ({
        id: String(l._id),
        label: `${l.name ?? ""} ${l.code ? `(${l.code})` : ""}`.trim(),
      })),
      preferredHashtags: prefHashtagsDocs.map((h) => ({
        id: String(h._id),
        label: String(h.hashtag ?? h.tag ?? h.name ?? ""),
      })),
    };

    const ui = {
      source: {
        campaignTitle: titleR.value,
        description: descR.value,
        campaignType: clean(req.body.campaignType) || "",
        categoryId: catR.value,
        subcategoryIds: subR.value,
        productLink: productLink || null,
        videoLink: videoLink || null,
        targetCountryIds: countryR.value,
        targetAgeRanges: ageR.value,
        additionalNotes: clean(req.body.additionalNotes) || "",
      },
      allowedOptions: allowed,
      guidance: {
        timezone: tz,
        todayLocal: nowLocal.toFormat("yyyy-LL-dd"),
        datetimeFormat: "yyyy-MM-dd'T'HH:mm",
        platformsAllowed: ["youtube", "instagram", "tiktok"],
        paymentTypesAllowed: ["Milestone", "Fixed", "Gifting"],
        hints: [
          "Infer sensible influencer count based on campaign type/category/description and budget.",
          "Pick formats/goals/tier based on description + category/CategoryModel.",
        ],
      },
    };

    const warnings = [];

    const defaultStartEnd = () => {
      const start = DateTime.now()
        .setZone(tz)
        .plus({ days: 1 })
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      const end = start.plus({ days: 10 });
      const fmt = (d) =>
        d.toISO({ suppressSeconds: true, suppressMilliseconds: true, includeOffset: false });
      return { startAt: fmt(start), endAt: fmt(end) };
    };

    const normalizeIsoLocal = (s) => {
      const v = clean(s);
      if (!v) return "";
      const dt = DateTime.fromISO(v, { zone: tz });
      if (!dt.isValid) return "";
      return dt.toISO({ suppressSeconds: true, suppressMilliseconds: true, includeOffset: false });
    };

    const pickIds = (value, allowedIds, min = 0) => {
      const set = new Set(allowedIds);
      const picked = normalizeObjectIdArray(value).filter((id) => set.has(id));
      if (picked.length >= min) return picked;
      return allowedIds.slice(0, Math.min(min, allowedIds.length));
    };




    const normalizePayment = (v) => {
      const s = clean(v);
      const x = normalizePaymentType(s || "Milestone");
      if (["Milestone", "Fixed", "Gifting"].includes(x)) return x;
      return "Milestone";
    };

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    let aiJson = {};

    if (!process.env.OPENAI_API_KEY) {
      warnings.push("OPENAI_API_KEY missing: returned fallback prefill (no AI enrichment).");
    } else {
      try {
        const prompt = buildAIPrompt(ui);

        const aiResp = await openai.responses.create({
          model,
          input: [
            { role: "system", content: "Return JSON only. No markdown." },
            { role: "user", content: prompt },
          ],
          text: { format: { type: "json_object" } },
          temperature: 0.35,
          max_output_tokens: 1200,
        });

        try {
          aiJson = JSON.parse(aiResp.output_text || "{}");
        } catch {
          warnings.push("AI returned invalid JSON: returned fallback values where needed.");
          aiJson = {};
        }
      } catch (e) {
        warnings.push(`AI call failed: ${String(e?.message || "unknown error")}. Returned fallback values.`);
        aiJson = {};
      }
    }

    const allowedGoalIds = allowed.campaignGoals.map((x) => x.id);
    const allowedTierIds = allowed.influencerTiers.map((x) => x.id);
    const allowedFormatIds = allowed.contentFormats.map((x) => x.id);
    const allowedLangIds = allowed.contentLanguages.map((x) => x.id);
    const allowedHashIds = allowed.preferredHashtags.map((x) => x.id);

    const goalsPick = pickIds(aiJson.campaignGoals, allowedGoalIds, 1);
    const tiersPick = pickIds(aiJson.influencerTierIds, allowedTierIds, 1);
    const formatsPick = pickIds(aiJson.contentFormats, allowedFormatIds, 1);

    const langsPick = pickIds(aiJson.contentLanguageIds, allowedLangIds, 0);
    const hashtagsPick = pickIds(aiJson.preferredHashtags, allowedHashIds, 0);

    const platformsPick = (() => {
      const ps = toPlatformArray(aiJson.platformSelection);
      return ps.length ? ps : ["instagram"];
    })();

    const paymentPick = normalizePayment(aiJson.paymentType);
    const budgetPick = Math.max(0, Math.trunc(toNumber(aiJson.campaignBudget) || 0));
    const numInfluencersPick = clampInt(aiJson.numberOfInfluencers, 1, 1, 100000);

    const minFollowersRaw = toInt(aiJson.minFollowers);
    const maxFollowersRaw = toInt(aiJson.maxFollowers);

    let minFollowersPick = Number.isFinite(minFollowersRaw) ? Math.max(0, minFollowersRaw) : undefined;
    let maxFollowersPick = Number.isFinite(maxFollowersRaw) ? Math.max(0, maxFollowersRaw) : undefined;

    if (typeof minFollowersPick === "number" && minFollowersPick > 0 && minFollowersPick < MIN_FOLLOWERS_ALLOWED) {
      warnings.push(`AI suggested minFollowers below ${MIN_FOLLOWERS_ALLOWED}; removed.`);
      minFollowersPick = undefined;
    }
    if (typeof maxFollowersPick === "number" && maxFollowersPick > 0 && maxFollowersPick < MIN_FOLLOWERS_ALLOWED) {
      warnings.push(`AI suggested maxFollowers below ${MIN_FOLLOWERS_ALLOWED}; removed.`);
      maxFollowersPick = undefined;
    }

    let startAtPick = normalizeIsoLocal(aiJson.startAt);
    let endAtPick = normalizeIsoLocal(aiJson.endAt);
    if (!startAtPick || !endAtPick) {
      const d = defaultStartEnd();
      startAtPick = startAtPick || d.startAt;
      endAtPick = endAtPick || d.endAt;
    }

    const st = DateTime.fromISO(startAtPick, { zone: tz });
    const en = DateTime.fromISO(endAtPick, { zone: tz });
    if (!st.isValid || !en.isValid || en <= st) {
      const d = defaultStartEnd();
      startAtPick = d.startAt;
      endAtPick = d.endAt;
      warnings.push("Invalid AI startAt/endAt: replaced with safe default window.");
    }

    const enhancedDescription = clean(aiJson.enhancedDescription) || descR.value;
    const enhancedTitle = clean(aiJson.enhancedTitle) || titleR.value;

    const prefill = {
      brandId: brandIdR.value,
      categoryId: catR.value,
      subcategoryIds: subR.value,
      targetCountryIds: countryR.value,
      targetAgeRanges: ageR.value,
      campaignTitle: enhancedTitle,
      description: enhancedDescription,
      campaignType: clean(req.body.campaignType) || "",
      productImages: imgs,
      productLink: productLink || undefined,
      videoLink: videoLink || undefined,
      campaignGoals: goalsPick,
      influencerTierIds: tiersPick,
      contentFormats: formatsPick,
      contentLanguageIds: langsPick,
      preferredHashtags: hashtagsPick,
      platformSelection: platformsPick,
      paymentType: paymentPick,
      campaignBudget: budgetPick,
      numberOfInfluencers: numInfluencersPick,
      minFollowers: minFollowersPick,
      maxFollowers: maxFollowersPick,
      startAt: startAtPick,
      endAt: endAtPick,
      additionalNotes: clean(req.body.additionalNotes) || clean(aiJson.additionalNotes) || "",
    };

    if (req.body.saveDraft === true) {
      const win = parseCampaignWindow(prefill, tz, requestId, res, false);
      if (!win.ok) return win.resp;

      const docToCreate = buildCampaignDoc(
        { ...prefill, status: "draft", campaignTimezone: tz },
        geo,
        "draft",
        1,
        win.value,
        {
          brandName: String(brandDoc.name || brandDoc.brandName || ""),
          createdBy: actor,
          approvalMode: actor.role === "admin" ? "admin_review" : "direct",
          categoryName: rel?.cat?.name || "",
          subcategoryNames: Array.isArray(rel?.subs) ? rel.subs.map((s) => String(s.name || "")) : [],
        }
      );

      const savedDoc = await Campaign.create(docToCreate);

      if (actor.role === "admin") {
        await notifyBrandDraftReady(savedDoc).catch(console.error);
      }

      const enrichedSaved = (await enrichCampaigns([savedDoc]))[0];

      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          prefill,
          prefillDetails,
          savedDraft: enrichedSaved,
          meta: {
            aiUsed: !!process.env.OPENAI_API_KEY,
            warnings,
            originalSource: {
              campaignTitle: titleR.value,
              description: descR.value,
            },
          },
        },
        requestId
      );
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        prefill,
        prefillDetails,
        meta: {
          aiUsed: !!process.env.OPENAI_API_KEY,
          warnings,
          originalSource: {
            campaignTitle: titleR.value,
            description: descR.value,
          },
        },
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
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
    const campaignId = clean(req.query.id);
    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: 'Valid campaign id is required.' });
    }

    const campaign = await Campaign.findById(campaignId).lean();
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
exports.deleteCampaignByCampaignId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !isOid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne({
      _id: toObjectId(campaignId),
      brandId: toObjectId(brandId),
    }).select("_id status campaignTitle");

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    const contractDoc = await Contract.findOne({
      campaignId: toObjectId(campaignId),
      brandId: toObjectId(brandId),
    })
      .select("_id contracts")
      .lean();

    const hasAnyContract = !!(
      contractDoc?.contracts?.length && contractDoc.contracts.length > 0
    );

    if (hasAnyContract && campaign.status !== "completed") {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Contract is sent; delete only after campaign is completed.",
        requestId
      );
    }

    await Promise.all([
      Campaign.deleteOne({
        _id: campaign._id,
        brandId: toObjectId(brandId),
      }),
      Contract.deleteOne({
        campaignId: toObjectId(campaignId),
        brandId: toObjectId(brandId),
      }),
    ]);

    return ApiResponse.sendOk(
      res,
      200,
      {
        message: "Campaign deleted successfully",
        deleted: {
          campaignId: String(campaign._id),
          campaignTitle: campaign.campaignTitle,
          status: campaign.status,
          hadContracts: hasAnyContract,
        },
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
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
      data: campaigns.map((c) => ({ ...c, influencerWorking: acceptedSet.has(String(c._id)) })),
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
    if (!isOid(campaignId)) {
      return res.status(400).json({ message: 'Invalid campaignId' });
    }

    const campaign = await Campaign.findById(campaignId).lean();
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

    const filter = { _id: { $in: toCampaignObjectIds(campaignIds) }, isActive: 1 };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, raw] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: raw.map((c) => ({ ...c, hasApplied: 1, isContracted: 1, isAccepted: acceptedMap.get(toStr(String(c._id))) || 0, hasMilestone: 1, contractId: contractIdMap.get(toStr(String(c._id))) || null, feeAmount: feeMap.get(toStr(String(c._id))) || 0, contractStatus: statusMap.get(toStr(String(c._id))) || null, milestonesCreatedAt: milestonesCreatedAtMap.get(toStr(String(c._id))) || null }))
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

    const filter = { _id: { $in: toCampaignObjectIds(campaignIds) } };
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
        const details = contractByCampaignId.get(String(String(c._id) || "")) || contractByCampaignId.get(String(c._id || "")) || {};
        return { ...c, hasApplied: 1, isContracted: 1, isAccepted: details.isAccepted || 0, hasMilestone: (milestoneCampaignSet.has(String(String(c._id) || "")) || milestoneCampaignSet.has(String(c._id || ""))) ? 1 : 0, contractId: details.contractId ?? null, feeAmount: details.feeAmount ?? 0, contractStatus: details.status ?? null };
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
      const maybeObjIds = categoryIds.filter(
        (v) => typeof v === "string" && mongoose.Types.ObjectId.isValid(v)
      );

      if (maybeObjIds.length) {
        filter["categoryId"] = { $in: maybeObjIds.map((id) => new mongoose.Types.ObjectId(id)) };
      }
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
    if (!isOid(campaignsId)) {
      return res.status(400).json({ message: 'Valid campaign id is required.' });
    }

    const campaign = await Campaign.findById(campaignsId, 'productOrServiceName budget timeline').lean();
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

    const workingIds = await Contract.distinct("campaignId", { brandId, campaignId: { $in: rows.map((c) => String(String(c._id) || c._id)) }, ...activeAcceptedFilter() });
    const workingSet = new Set(workingIds.map(String));

    return res.json({
      data: rows.map((c) => {
        const tl = c.timeline || {};
        const state = (!tl.startDate && !tl.endDate) ? "none" : (tl.endDate && new Date(tl.endDate) < startOfTodayUTC) ? "expired" : "running";
        return { ...c, computedIsActive: computeIsActive(c.timeline), timelineState: state, hasTimeline: state !== "none", influencerWorking: workingSet.has(String(String(c._id) || "")) || workingSet.has(String(c._id || "")) };
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

    const campaignId = clean(req.query.id);
    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId);
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
    const campaignId = clean(req.query.id);
    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId);
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



exports.getCategories = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = clean(req.query.search);
    const filter = {};

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { name: regex },
        { globalTags: regex },
        { "subcategories.name": regex },
        { "subcategories.tags": regex },
      ];
    }

    const data = await CategoryModel.find(filter).sort({ name: 1 }).lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};


exports.getSubcategories = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const categoryId = clean(req.query.categoryId);
    const search = clean(req.query.search);
    const rx = search ? new RegExp(escapeRegex(search), "i") : null;

    const normalizeTags = (obj) => {
      const t = obj?.tag ?? obj?.tags ?? [];
      return Array.isArray(t) ? t : t ? [t] : [];
    };

    const normalizeGlobalTags = (cat) => {
      const gt = cat?.globalTags ?? cat?.tags ?? [];
      return Array.isArray(gt) ? gt : gt ? [gt] : [];
    };

    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "categoryId",
          requestId,
          "Invalid categoryId"
        );
      }

      const cat = await CategoryModel.findById(categoryId)
        .select("_id name subcategories globalTags tags")
        .lean();

      if (!cat) {
        return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Category not found", requestId);
      }

      const subs = cat.subcategories ?? [];
      const filtered = rx ? subs.filter((s) => rx.test(String(s.name ?? ""))) : subs;

      const globalTags = normalizeGlobalTags(cat);

      const data = filtered
        .map((s) => ({
          _id: s._id,
          name: s.name,
          tags: normalizeTags(s),
          globalTags,
          categoryId: cat._id,
          categoryName: cat.name,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

      return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
    }

    const pipeline = [{ $unwind: "$subcategories" }];

    if (rx) {
      pipeline.push({ $match: { "subcategories.name": { $regex: rx } } });
    }

    pipeline.push(
      {
        $project: {
          _id: "$subcategories._id",
          name: "$subcategories.name",
          tags: { $ifNull: ["$subcategories.tag", "$subcategories.tags"] },
          globalTags: { $ifNull: ["$globalTags", "$tags"] },
          categoryId: "$_id",
          categoryName: "$name",
        },
      },
      { $sort: { name: 1 } },
      { $limit: 1000 }
    );

    const data = await CategoryModel.aggregate(pipeline);
    return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};



exports.viewCampaignByIdForBrand = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const user = req.user || {};

    const tokenBrandRaw = String(
      user.brandId ?? user.id ?? user._id ?? user.userId ?? ""
    ).trim();

    if (!tokenBrandRaw) {
      return fail(res, 401, "UNAUTHORIZED", "Invalid brand token", requestId);
    }

    const tokenBrandDoc = await findBrandDocByAnyId(tokenBrandRaw);
    if (!tokenBrandDoc) {
      return fail(res, 401, "UNAUTHORIZED", "Brand not found from token", requestId);
    }

    const bodyBrandId = clean(req.body.brandId);
    if (!bodyBrandId) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const bodyBrandDoc = await findBrandDocByAnyId(bodyBrandId);
    if (!bodyBrandDoc) {
      return fail(res, 404, "NOT_FOUND", "Brand not found", requestId);
    }

    if (String(tokenBrandDoc._id) !== String(bodyBrandDoc._id)) {
      return fail(res, 403, "FORBIDDEN", "brandId does not match token", requestId);
    }

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    if (!isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne(
      buildCampaignLookupFilter(campaignId, bodyBrandDoc._id)
    );


    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    const enriched = (await enrichCampaigns([campaign]))[0];

    return ApiResponse.sendOk(res, 200, { doc: enriched }, requestId);
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};
exports.getRecommendedInfluencersByCampaignId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    if (!brandId || !Types.ObjectId.isValid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    if (!isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne({
      _id: new Types.ObjectId(campaignId),
      brandId: new Types.ObjectId(brandId),
    })
      .select("_id campaignsId brandId categoryId status")
      .lean();

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found for this brand", requestId);
    }

    const categoryId = String(campaign.categoryId || "").trim();
    if (!categoryId || !Types.ObjectId.isValid(categoryId)) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Campaign categoryId is missing. Please select at least one category.",
        requestId
      );
    }

    const catOid = new Types.ObjectId(categoryId);

    const match = {
      $or: [
        { "categories._id": catOid },
        { categories: catOid },
        { categoryId: catOid },
        { categoryIds: { $in: [catOid] } },
      ],
    };

    const [items, total] = await Promise.all([
      Influencer.find(match)
        .select("-password")
        .skip(skip)
        .limit(limit)
        .lean(),
      Influencer.countDocuments(match),
    ]);

    const out = (items || []).map((inf) => ({
      ...inf,
      _id: String(inf._id),
      influencerId: String(inf._id),
    }));

    return ApiResponse.sendOk(
      res,
      200,
      {
        items: out,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

exports.updateStatus = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);
    const statusRaw = clean(req.body.status);

    if (!brandId || !isOid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const allowedStatuses = ["draft", "active", "paused", "completed", "archived"];

    if (!statusRaw || !allowedStatuses.includes(statusRaw)) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${allowedStatuses.join(", ")}`,
        requestId
      );
    }

    const existing = await Campaign.findById(campaignId).select(
      "_id status brandId publishedAt endedAt isActive isDraft publishStatus campaignStatus statusUpdatedAt"
    );

    if (!existing) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    if (String(existing.brandId) !== String(brandId)) {
      return fail(res, 404, "NOT_FOUND", "Campaign does not belong to this brand", requestId);
    }

    const currentStatus = existing.status;
    const newStatus = statusRaw;

    if (currentStatus === newStatus) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        `Campaign is already in '${newStatus}' status`,
        requestId
      );
    }

    if (currentStatus === "completed") {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Completed campaign status cannot be changed",
        requestId
      );
    }

    if (currentStatus === "archived") {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Archived campaign status cannot be changed",
        requestId
      );
    }

    existing.status = newStatus;
    existing.statusUpdatedAt = new Date();

    existing.isDraft = newStatus === "draft" ? 1 : 0;
    existing.isActive = newStatus === "active" ? 1 : 0;

    if (newStatus === "draft") {
      existing.publishStatus = "draft";
      existing.campaignStatus = "paused";
      existing.publishedAt = undefined;
      existing.endedAt = undefined;
    }

    if (newStatus === "active") {
      existing.publishStatus = "published";
      existing.campaignStatus = "open";
      existing.publishedAt = existing.publishedAt || new Date();
      existing.endedAt = undefined;
    }

    if (newStatus === "paused") {
      existing.publishStatus = "published";
      existing.campaignStatus = "paused";
    }

    if (newStatus === "completed") {
      existing.publishStatus = "published";
      existing.campaignStatus = "paused";
      existing.isActive = 0;
      existing.endedAt = existing.endedAt || new Date();
    }

    if (newStatus === "archived") {
      existing.publishStatus = "archived";
      existing.campaignStatus = "paused";
      existing.isActive = 0;
      existing.endedAt = existing.endedAt || new Date();
    }

    await existing.save();

    return ApiResponse.sendOk(
      res,
      200,
      { message: "Status updated successfully" },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

exports.updateManualCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const bodyBrandId = clean(req.body.brandId);
    if (!bodyBrandId) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "brandId", requestId);
    }

    const brandDoc = await findBrandDocByAnyId(bodyBrandId);
    if (!brandDoc) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Brand not found", requestId);
    }

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignId", requestId);
    }

    const existingCampaign = await Campaign.findOne(
      buildCampaignLookupFilter(campaignId, brandDoc._id)
    );

    if (!existingCampaign) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Campaign not found", requestId);
    }

    const campaignTz = getCampaignTimezone(req.body, existingCampaign.campaignTimezone);
    req.body.campaignTimezone = campaignTz;

    const status = pickStatus(req.body.status || existingCampaign.status || "active");
    const mode = status === "scheduled" ? "schedule" : status === "draft" ? "draft" : "publish";

    const v = await validateForMode(res, requestId, mode, req.body, {
      existingProductImages: existingCampaign.productImages || existingCampaign.images || [],
    });
    if (!v.ok) return v.resp;

    let timing = {};

    if (status === "draft") {
      timing = parseDraftWindowSoft(req.body, campaignTz);
    } else if (status === "scheduled") {
      const sch = parseSchedule(req.body, campaignTz, requestId, res);
      if (!sch.ok) return sch.resp;
      timing = sch.value;
    } else {
      const win = parseCampaignWindowForUpdate(req.body, campaignTz, requestId, res, {
        allowPastStart: true,
      });
      if (!win.ok) return win.resp;
      timing = win.value;
    }

    const rel = await resolveCategoryAndSubcategories(
      clean(req.body.categoryId),
      normalizeObjectIdArray(req.body.subcategoryIds)
    );

    if (rel.error) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "subcategoryIds",
        requestId,
        rel.error
      );
    }

    const mergedBody = {
      ...req.body,
      productImages: toUnknownArray(req.body.productImages).length
        ? req.body.productImages
        : existingCampaign.productImages || existingCampaign.images || [],
    };

    const patch = buildCampaignUpdatePatch(
      mergedBody,
      existingCampaign,
      status,
      timing,
      {
        categoryName: rel?.cat?.name || "",
        subcategoryNames: Array.isArray(rel?.subs)
          ? rel.subs.map((s) => String(s.name || ""))
          : [],
      }
    );

    Object.assign(existingCampaign, patch);
    await existingCampaign.save();

    const enriched = (await enrichCampaigns([existingCampaign]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Campaign updated successfully.",
        doc: enriched,
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

