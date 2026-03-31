const mongoose = require("mongoose");
const { Types } = require("mongoose");
const multer = require("multer");
const OpenAI = require("openai");
const { DateTime } = require("luxon");
const { normalizeAndUploadProductImages } = require("../utils/uploadBase64ImagesToS3.js");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { Category } = require("../models/categories");
const ApplyCampaign = require("../models/applyCampaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Contract = require("../models/contract");
const Country = require("../models/country");
const Modash = require("../models/modash");
const { AdminModel: Admin } = require("../models/master");

const { AgeRangeModel: AgeRange } = require("../models/ageRange");
const ContentLanguage = require("../models/language");
const { InfluencerTierModel: InfluencerTier } = require("../models/influencerTier");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { ContentFormatModel: ContentFormat } = require("../models/contentFormat");
const { PreferredHashtagModel: PreferredHashtag } = require("../models/preferredHashtag");

// adjust these two imports only if your actual paths differ
const Milestone = require("../models/milestone");
const getFeature = require("../utils/getFeature");

const { CONTRACT_STATUS } = require("../constants/contract");
const { createAndEmit } = require("../utils/notifier");
const { detectGeoFromRequest } = require("../utils/ipGeo");
const { ApiResponse } = require("../core/http/ApiResponse.js");
const { HttpStatus } = require("../core/http/HttpStatus.js");

// ===============================
// helpers
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
  const allowed = ["draft", "scheduled", "active", "paused", "completed", "archived"];
  const s = clean(v);
  return allowed.includes(s) ? s : "draft";
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
  const cat = await Category.findById(categoryId)
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
      ? Category.find({ _id: { $in: [...categoryIds].map((id) => toObjectId(id)) } })
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
      id: String(c._id || ""),
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
  if (!isOid(raw)) return null;

  const filter = { _id: toObjectId(raw) };
  if (brandObjectId) filter.brandId = brandObjectId;
  return filter;
};

const buildContractCampaignFilter = (campaignId) => {
  const raw = clean(campaignId);
  const or = [{ campaignId: raw }];
  if (isOid(raw)) or.push({ campaignId: toObjectId(raw) });
  return { $or: or };
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
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, "startAt must be < endAt"),
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
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, "startAt must be < endAt"),
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
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        chk.message
      ),
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
    value: {
      scheduledAt: scheduledAtUtc,
      startAt: win.value.startAt,
      endAt: win.value.endAt,
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

const inferMode = (statusRaw, scheduledAt) => {
  if (clean(scheduledAt)) return "schedule";

  const statusStr = clean(statusRaw);
  if (!statusStr) return "publish";

  const status = pickStatus(statusRaw);
  if (status === "draft") return "draft";
  if (status === "scheduled") return "schedule";
  return "publish";
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
  String(campaign?.campaignTitle || "Campaign").trim();

const toCampaignObjectIds = (ids = []) =>
  ids.map((id) => clean(String(id))).filter(isOid).map(toObjectId);

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

  if (!incomingProductImages.length && !existingProductImages.length) {
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
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "minFollowers", requestId, "Min followers must be a number."),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "minFollowers", requestId, `Min followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`),
      };
    }
    minFollowers = n;
  }

  if (maxFollowersRaw) {
    const n = toInt(body.maxFollowers);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, "Max followers must be a number."),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, `Max followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`),
      };
    }
    if (typeof minFollowers === "number" && n < minFollowers) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, "Max followers must be greater than or equal to min followers."),
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
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignBudget", requestId, "campaignBudget must be >= 0"),
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
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId) };
  }
  if (!hasDateInput(body.endAt)) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId) };
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

  const createdLocation = {
    ip: geo?.ip,
    timezone: geo?.timezone,
    country: geo?.country,
    state: geo?.state,
    city: geo?.city,
    latitude: typeof geo?.latitude === "number" ? geo.latitude : undefined,
    longitude: typeof geo?.longitude === "number" ? geo.longitude : undefined,
    source: geo?.source,
  };

  const base = {
    brandId: toObjectId(body.brandId),
    brandName: clean(extra.brandName) || "",
    byAi,

    createdLocation,
    createdBy: extra.createdBy
      ? {
        role: extra.createdBy.role,
        userId: extra.createdBy.userId,
        userModel:
          extra.createdBy.userModel ||
          (extra.createdBy.role === "admin" ? "Master" : "Brand"),
        email: extra.createdBy.email || "",
        name: extra.createdBy.name || "",
        adminRole: extra.createdBy.adminRole || "",
      }
      : null,
    approvalMode: extra.approvalMode || "direct",

    status,
    campaignTimezone: clean(body.campaignTimezone) || DEFAULT_CAMPAIGN_TZ,

    campaignTitle: clean(body.campaignTitle),
    description: isDraft ? strOrUndef(body.description) : clean(body.description),
    campaignType: isDraft ? strOrUndef(body.campaignType) : clean(body.campaignType) || "",

    campaignCategory: extra.categoryName || "",
    campaignSubcategory: Array.isArray(extra.subcategoryNames) ? extra.subcategoryNames.join(", ") : "",

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
    targetCountryIds: isDraft ? oidArrayOrUndef(body.targetCountryIds) : oidArray(body.targetCountryIds),
    targetAgeRanges: isDraft ? oidArrayOrUndef(body.targetAgeRanges) : oidArray(body.targetAgeRanges),

    numberOfInfluencers: Number.isFinite(numInfluencers) ? numInfluencers : 0,
    minFollowers: Number.isFinite(minFollowers) ? minFollowers : 0,
    maxFollowers: Number.isFinite(maxFollowers) ? maxFollowers : 0,

    campaignBudget: Number.isFinite(budget) ? budget : 0,
    budget: Number.isFinite(budget) ? budget : 0,
    influencerBudget: Number.isFinite(toNumber(body.influencerBudget)) ? toNumber(body.influencerBudget) : 0,

    paymentType: clean(body.paymentType) ? normalizePaymentType(body.paymentType) : "Milestone",

    platformSelection: (() => {
      const ps = toPlatformArray(body.platformSelection);
      return isDraft ? (ps.length ? ps : undefined) : ps;
    })(),

    additionalNotes: isDraft ? strOrUndef(body.additionalNotes) : clean(body.additionalNotes) || "",

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : "published",
    statusUpdatedAt: new Date(),

    categories: Array.isArray(extra.subcategoryNames)
      ? extra.subcategoryNames.map((subName, idx) => ({
        categoryId: String(body.categoryId || ""),
        categoryName: extra.categoryName || "",
        subcategoryId: String(normalizeObjectIdArray(body.subcategoryIds)[idx] || ""),
        subcategoryName: subName,
      }))
      : [],
  };

  if (timing?.scheduledAt) base.scheduledAt = timing.scheduledAt;
  if (timing?.startAt) base.startAt = timing.startAt;
  if (timing?.endAt) base.endAt = timing.endAt;

  if (timing?.startAt || timing?.endAt) {
    base.timeline = {
      startDate: timing?.startAt || null,
      endDate: timing?.endAt || null,
    };
  }

  if (status === "active") {
    base.publishedAt = new Date();
    base.scheduledAt = undefined;
    base.scheduledLocation = undefined;
  }

  if (status === "draft") {
    base.publishedAt = undefined;
    base.scheduledAt = undefined;
    base.scheduledLocation = undefined;
  }

  if (status === "scheduled") {
    base.publishedAt = undefined;
    base.scheduledLocation = createdLocation;
  }

  return base;
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
    description: clean(body.description) || existing.description,
    campaignType: clean(body.campaignType) || existing.campaignType || "",

    categoryId: toOidOrFallback(body.categoryId, existing.categoryId),
    subcategoryIds: toOidArrayOrFallback(body.subcategoryIds, existing.subcategoryIds || []),

    productImages: toUnknownArray(body.productImages).length
      ? toUnknownArray(body.productImages)
      : toUnknownArray(existing.productImages),

    productLink: clean(body.productLink) || existing.productLink || "",
    videoLink: clean(body.videoLink) || existing.videoLink || "",

    campaignGoals: toOidArrayOrFallback(body.campaignGoals, existing.campaignGoals || []),
    influencerTierIds: toOidArrayOrFallback(body.influencerTierIds, existing.influencerTierIds || []),
    contentFormats: toOidArrayOrFallback(body.contentFormats, existing.contentFormats || []),
    contentLanguageIds: toOidArrayOrFallback(body.contentLanguageIds, existing.contentLanguageIds || []),
    preferredHashtags: toOidArrayOrFallback(body.preferredHashtags, existing.preferredHashtags || []),

    platformSelection: toPlatformArray(body.platformSelection).length
      ? toPlatformArray(body.platformSelection)
      : existing.platformSelection || [],

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
      Number.isFinite(minFollowers) && minFollowers >= 0
        ? minFollowers
        : existing.minFollowers,

    maxFollowers:
      Number.isFinite(maxFollowers) && maxFollowers >= 0
        ? maxFollowers
        : existing.maxFollowers,

    additionalNotes: clean(body.additionalNotes) || existing.additionalNotes || "",

    status,
    campaignTimezone: clean(body.campaignTimezone) || existing.campaignTimezone || DEFAULT_CAMPAIGN_TZ,

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : "published",
    statusUpdatedAt: new Date(),
  };

  if (extra.categoryName) {
    patch.campaignCategory = extra.categoryName;
  }

  if (Array.isArray(extra.subcategoryNames)) {
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
    startDate: timing?.startAt || existing.startAt || existing.timeline?.startDate || null,
    endDate: timing?.endAt || existing.endAt || existing.timeline?.endDate || null,
  };

  if (status === "active") {
    patch.publishedAt = existing.publishedAt || new Date();
  }

  return patch;
};

async function notifyBrandDraftReady(campaign) {
  const title = getCampaignDisplayName(campaign);
  const entityId = String(campaign._id);

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

async function notifyBrandApproved(campaign) {
  const title = getCampaignDisplayName(campaign);
  const entityId = String(campaign._id);

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
  const entityId = String(campaign._id);

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

async function notifyMatchingInfluencersForNewCampaign(campaignDoc, subIds = []) {
  try {
    if (!Array.isArray(subIds) || !subIds.length) return;

    const influencers = await findMatchingInfluencers({ subIds, catNumIds: [] });
    if (!Array.isArray(influencers) || !influencers.length) return;

    const entityId = String(campaignDoc._id);
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
}

// ===============================
// multer
// ===============================

const storage = multer.memoryStorage();
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);
const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

function fileFilter(req, file, cb) {
  if (file.fieldname === "image") return cb(null, IMAGE_MIMES.has(file.mimetype));
  if (file.fieldname === "creativeBrief") return cb(null, DOC_MIMES.has(file.mimetype));
  return cb(null, false);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
}).fields([
  { name: "image", maxCount: 10 },
  { name: "creativeBrief", maxCount: 10 },
]);

// ===============================
// unchanged utility functions
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
  const isMasterRole = ["super_admin", "revenue_head", "ime", "bme"].includes(role);


  if (
    isMasterRole ||
    role.includes("admin") ||
    req.user?.isAdmin === true ||
    req.user?.adminId ||
    req.body?.adminId ||
    req.body?.adminMongoId ||
    req.body?.adminEmail ||
    req.query?.adminId
  ) {
    return true;
  }

  if (role.includes("brand") || req.user?.brandId) {
    return false;
  }

  return false;
}

async function findAdminDoc(rawValue) {
  const v = String(rawValue || "").trim();
  if (!v) return null;

  if (mongoose.Types.ObjectId.isValid(v)) {
    const byId = await Admin.findById(v)
      .select("_id email name role status")
      .lean();
    if (byId) return byId;
  }

  const byEmail = await Admin.findOne({ email: v.toLowerCase() })
    .select("_id email name role status")
    .lean();

  if (byEmail) return byEmail;

  return null;
}
async function resolveActorFromPayload(req, fallbackBrandId = "") {
  const role = String(req.user?.role || req.user?.userType || "").toLowerCase();

  const findAdminDoc = async (rawValue) => {
    const v = String(rawValue || "").trim();
    if (!v) return null;

    // try by Mongo _id
    if (mongoose.Types.ObjectId.isValid(v)) {
      const byId = await Admin.findById(v)
        .select("_id email name role status")
        .lean();
      if (byId) return byId;
    }

    // fallback by email
    const byEmail = await Admin.findOne({ email: v.toLowerCase() })
      .select("_id email name role status")
      .lean();
    if (byEmail) return byEmail;

    return null;
  };

  const isMasterRole = ["super_admin", "revenue_head", "ime", "bme"].includes(role);

  const looksLikeAdmin =
    !req.user?.brandId &&
    (
      isMasterRole ||
      role.includes("admin") ||
      req.user?.isAdmin === true ||
      req.user?.adminId ||
      req.body?.adminId ||
      req.body?.adminMongoId ||
      req.body?.adminEmail ||
      req.user?.email
    );

  if (looksLikeAdmin) {
    const adminDoc =
      (await findAdminDoc(req.user?.adminId)) ||
      (await findAdminDoc(req.user?._id)) ||
      (await findAdminDoc(req.user?.id)) ||
      (await findAdminDoc(req.user?.email)) ||
      (await findAdminDoc(req.body?.adminMongoId)) ||
      (await findAdminDoc(req.body?.adminId)) ||
      (await findAdminDoc(req.body?.adminEmail));

    if (!adminDoc) {
      throw new Error("Admin actor detected but Admin record could not be resolved");
    }

    return {
      role: "admin",
      userId: adminDoc._id,
      userModel: "Master",
      email: adminDoc.email,
      name: adminDoc.name || "",
      adminRole: adminDoc.role,
    };
  }

  const brandDoc = await findBrandDocByAnyId(
    fallbackBrandId || req.user?.brandId || req.body?.brandId || ""
  );

  if (!brandDoc) {
    return { role: "brand", userId: null, userModel: "Brand" };
  }

  return {
    role: "brand",
    userId: brandDoc._id,
    userModel: "Brand",
  };
}

function mapCampaignForInfluencer(c) {
  if (!c) return c;
  const brandBudget = toNum(c.budget, 0);
  const infBudget = toNum(c.influencerBudget, 0);
  return {
    ...c,
    budget: infBudget > 0 ? infBudget : brandBudget,
    brandBudget,
    influencerBudget: infBudget,
  };
}

async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) throw new Error("brandId is required for quota checks");
  const brand = await Brand.findOne({ brandId }, "subscription").lean();
  if (!brand || !brand.subscription) throw new Error("Brand subscription not configured");
  const feature = getFeature.getFeature(brand.subscription, featureKey);
  if (!feature) return { limit: 0, used: 0, remaining: Infinity };
  const limit = readLimit(feature);
  const used = Number(feature.used || 0) || 0;
  if (limit === 0) return { limit: 0, used, remaining: Infinity };
  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = "QUOTA_EXCEEDED";
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }
  await Brand.updateOne({ brandId, "subscription.features.key": featureKey }, { $inc: { "subscription.features.$.used": amount } });
  return { limit, used: used + amount, remaining: limit - (used + amount) };
}

function readLimit(featureRow) {
  if (!featureRow) return 0;
  const raw = featureRow.limit ?? featureRow.value ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureMonthlyWindow(influencerId, featureKey, featureRow) {
  return featureRow;
}

async function countActiveCollaborationsForInfluencer(influencerId) {
  if (!influencerId) return 0;
  return Contract.countDocuments({ influencerId: String(influencerId), isRejected: { $ne: 1 }, isAccepted: 1 });
}

function activeAcceptedFilter() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
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

function computeIsActive(timeline) {
  if (!timeline || !timeline.endDate) return 1;
  const now = new Date();
  return timeline.endDate < now ? 0 : 1;
}

const toStr = (v) => (v == null ? "" : String(v));

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    { "milestoneHistory.influencerId": influencerId, "milestoneHistory.campaignId": { $in: campaignIds } },
    "milestoneHistory.campaignId milestoneHistory.influencerId"
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

function buildSearchOr(term) {
  const or = [
    { brandName: { $regex: term, $options: "i" } },
    { campaignTitle: { $regex: term, $options: "i" } },
    { description: { $regex: term, $options: "i" } },
    { campaignCategory: { $regex: term, $options: "i" } },
    { campaignSubcategory: { $regex: term, $options: "i" } },
    { "categories.subcategoryName": { $regex: term, $options: "i" } },
    { "categories.categoryName": { $regex: term, $options: "i" } },
  ];
  const num = Number(term);
  if (!isNaN(num)) {
    or.push({ budget: { $lte: num } });
    or.push({ influencerBudget: { $lte: num } });
  }
  return or;
}

async function buildSubToParentNumMap() {
  const rows = await Category.find({}, "_id subcategories").lean();
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
      { "onboarding.subcategories.subcategoryId": { $in: subIds } },
      { "subcategories.subcategoryId": { $in: subIds } },
      { "categories.subcategoryId": { $in: subIds } },
      { "socialProfiles.categories.subcategoryId": { $in: subIds } },
      { categories: { $in: subIds } }
    );
  }
  if (catNumIds.length) {
    or.push({ "onboarding.categoryId": { $in: catNumIds } }, { "categories.categoryId": { $in: catNumIds } });
  }
  const filter = or.length ? { $or: or } : {};
  const influencers = await Influencer.find(filter, "influencerId name primaryPlatform handle onboarding socialProfiles").lean();
  return influencers || [];
}

function addInfluencerOpenStatusGate(filter) {
  filter.$and = filter.$and || [];
  filter.$and.push({ status: "active" });
  return filter;
}

async function resolveAdminActor(req) {
  const findAdminDoc = async (rawValue) => {
    const v = String(rawValue || "").trim();
    if (!v) return null;

    if (mongoose.Types.ObjectId.isValid(v)) {
      const byId = await Admin.findById(v)
        .select("_id email name role status")
        .lean();
      if (byId) return byId;
    }

    const byEmail = await Admin.findOne({ email: v.toLowerCase() })
      .select("_id email name role status")
      .lean();
    if (byEmail) return byEmail;

    return null;
  };

  const adminDoc =
    (await findAdminDoc(req.user?.adminId)) ||
    (await findAdminDoc(req.user?._id)) ||
    (await findAdminDoc(req.user?.id)) ||
    (await findAdminDoc(req.user?.email)) ||
    (await findAdminDoc(req.body?.adminMongoId)) ||
    (await findAdminDoc(req.body?.adminId)) ||
    (await findAdminDoc(req.body?.adminEmail));

  if (!adminDoc) return null;

  return {
    role: "admin",
    userId: adminDoc._id,
    userModel: "Master",
    email: adminDoc.email,
    name: adminDoc.name || "",
    adminRole: adminDoc.role,
    adminStatus: adminDoc.status,
  };
}
// ===============================
// CREATE CAMPAIGN
// ===============================
exports.createCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {

    const geo = await detectGeoFromRequest(req);
    const campaignTz = getCampaignTimezone(req.body);

    const brandDoc = await findBrandDocByAnyId(req.body.brandId);
    if (!brandDoc) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Brand not found",
        requestId
      );
    }

    const actor = await resolveActorFromPayload(
      req,
      String(brandDoc.brandId || brandDoc._id || req.body.brandId || "")
    );

    const mode = inferMode(req.body.status, req.body.scheduledAt);

    const v = await validateForMode(res, requestId, mode, req.body);
    if (!v.ok) return v.resp;

    const status =
      mode === "draft"
        ? "draft"
        : mode === "schedule"
          ? "scheduled"
          : "active";

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

    const uploadedProductImages = await normalizeAndUploadProductImages(
      req.body.productImages
    );

    req.body.productImages = uploadedProductImages;

    const docToCreate = buildCampaignDoc(req.body, geo, status, 0, timing, {
      brandName: String(brandDoc.name || brandDoc.brandName || ""),
      createdBy: actor,
      approvalMode: actor.role === "admin" ? "admin_review" : "direct",
      categoryName: v?.rel?.cat?.name || "",
      subcategoryNames: Array.isArray(v?.rel?.subs)
        ? v.rel.subs.map((s) => String(s.name || ""))
        : [],
    });

    const created = await Campaign.create(docToCreate);

    if (status === "draft" && actor.role === "admin") {
      await notifyBrandDraftReady(created).catch(console.error);
    }

    if (status === "active") {
      await notifyMatchingInfluencersForNewCampaign(
        {
          ...created.toObject(),
          brandName: String(brandDoc.name || brandDoc.brandName || ""),
        },
        normalizeObjectIdArray(req.body.subcategoryIds)
      );
    }

    const enriched = (await enrichCampaigns([created]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.CREATED,
      { doc: enriched },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

// ===============================
// AI PREFILL
// ===============================
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
    const uploadedProductImages = await normalizeAndUploadProductImages(imgs);
    if (!imgs.length) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "productImages", requestId);
    }

    const productLink = clean(req.body.productLink);
    if (productLink && !isValidHttpUrl(productLink)) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "productLink", requestId, "productLink must be a valid http/https URL");
    }

    const videoLink = clean(req.body.videoLink);
    if (videoLink && !isValidHttpUrl(videoLink)) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "videoLink", requestId, "videoLink must be a valid http/https URL");
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
      productImages: uploadedProductImages,
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
// GET ALL
// ===============================
exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};

    if (req.query.brandId && isOid(req.query.brandId)) {
      filter.brandId = toObjectId(req.query.brandId);
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const skip = (page - 1) * limit;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({
      data: campaigns,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    return res.status(500).json({
      message: "Internal server error while fetching campaigns."
    });
  }
};

// ===============================
// GET SINGLE
// ===============================
exports.getCampaignById = async (req, res) => {
  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !isOid(brandId)) {
      return res.status(400).json({ message: "Valid brandId is required." });
    }

    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaignId is required." });
    }

    const campaign = await Campaign.findOne({
      _id: campaignId,
      brandId: brandId,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found." });
    }

    const actorIsAdmin = isAdminRequest(req);
    const actorBrandId = String(req.user?.brandId || "");
    const isOwnerBrand =
      !actorIsAdmin &&
      actorBrandId &&
      actorBrandId === String(campaign.brandId);

    if (
      (actorIsAdmin || isOwnerBrand) &&
      campaign.pendingUpdate?.status === "pending" &&
      campaign.pendingUpdate?.patch
    ) {
      return res.json({
        ...campaign,
        pendingApproval: 1,
        pendingPatch: campaign.pendingUpdate.patch,
      });
    }

    return res.json(campaign);
  } catch (error) {
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ===============================
// DELETE
// ===============================
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
      brandId: toObjectId(brandId),
      ...buildContractCampaignFilter(campaignId),
    })
      .select("_id contracts")
      .lean();

    const hasAnyContract = !!(contractDoc?.contracts?.length && contractDoc.contracts.length > 0);

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
      Contract.deleteMany({
        brandId: toObjectId(brandId),
        ...buildContractCampaignFilter(campaignId),
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

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId required" });
  }

  try {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    // ✅ support both Mongo _id and custom influencerId
    const influencerLookup = mongoose.Types.ObjectId.isValid(String(influencerId))
      ? {
        $or: [
          { _id: influencerId },
          { influencerId: String(influencerId) }
        ]
      }
      : { influencerId: String(influencerId) };

    const inf = await Influencer.findOne(influencerLookup).lean();

    if (!inf) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const publicInfluencerId = String(inf.influencerId || inf._id);

    const subIdToParentNum = await buildSubToParentNumMap();

    const selectedSubIds = new Set(
      (inf.onboarding?.subcategories || [])
        .map((s) => s?.subcategoryId)
        .filter(Boolean)
        .map(String)
    );

    const selectedCatNumIds = new Set();

    if (typeof inf.onboarding?.categoryId === "number") {
      selectedCatNumIds.add(inf.onboarding.categoryId);
    }

    for (const subId of selectedSubIds) {
      const parentNum = subIdToParentNum.get(subId);
      if (typeof parentNum === "number") {
        selectedCatNumIds.add(parentNum);
      }
    }

    if (selectedSubIds.size === 0 && selectedCatNumIds.size === 0) {
      return res.json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        campaigns: [],
      });
    }

    const orClauses = [];

    if (selectedSubIds.size) {
      orClauses.push({
        "categories.subcategoryId": { $in: Array.from(selectedSubIds) },
      });
    }

    if (selectedCatNumIds.size) {
      orClauses.push({
        "categories.categoryId": { $in: Array.from(selectedCatNumIds) },
      });
    }

    const filter = {
      isActive: 1,
      isDraft: { $ne: 1 },
      $or: orClauses,
    };

    if (search?.trim()) {
      filter.$and = [{ $or: buildSearchOr(search.trim()) }];
    }

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
    ]);

    let canApply = true;

    const applyF = (inf.subscription?.features || []).find(
      (f) => f.key === "apply_to_campaigns_quota"
    );

    if (applyF) {
      const fReset = await ensureMonthlyWindow(
        publicInfluencerId,
        "apply_to_campaigns_quota",
        applyF
      );

      if (
        readLimit(fReset) > 0 &&
        Number(fReset.used || 0) >= readLimit(fReset)
      ) {
        canApply = false;
      }
    }

    const cap = readLimit(
      (inf.subscription?.features || []).find(
        (f) => f.key === "active_collaborations_limit"
      )
    );

    if (
      cap > 0 &&
      (await countActiveCollaborationsForInfluencer(publicInfluencerId)) >= cap
    ) {
      canApply = false;
    }

    return res.json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      campaigns: campaigns.map((c) => ({
        ...c,
        hasApplied: 0,
        hasApproved: 0,
        isContracted: 0,
        contractId: null,
        isAccepted: 0,
        canApply,
      })),
    });
  } catch (err) {
    console.error("getCampaignsByInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
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

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId required" });
  }

  try {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    // ✅ support both Mongo _id and custom influencerId
    const influencerLookup = mongoose.Types.ObjectId.isValid(String(influencerId))
      ? {
        $or: [
          { _id: influencerId },
          { influencerId: String(influencerId) }
        ]
      }
      : { influencerId: String(influencerId) };

    const inf = await Influencer.findOne(influencerLookup, "_id influencerId").lean();

    if (!inf) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const internalInfluencerId = String(inf._id);
    const publicInfluencerId = String(inf.influencerId || inf._id);

    // ✅ fetch applied campaigns using either internal _id or public influencerId
    const applyRecs = await ApplyCampaign.find(
      {
        $or: [
          { "applicants.influencerId": internalInfluencerId },
          { "applicants.influencerId": publicInfluencerId }
        ]
      },
      "campaignId"
    ).lean();

    let campaignIds = [
      ...new Set(
        applyRecs
          .map((r) => String(r.campaignId || "").trim())
          .filter(Boolean)
      )
    ];

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0
        },
        campaigns: []
      });
    }

    // ✅ exclude contracted/accepted campaigns using either influencer id style
    const contracted = await Contract.find(
      {
        influencerId: { $in: [internalInfluencerId, publicInfluencerId] },
        campaignId: { $in: campaignIds },
        $or: [{ isAssigned: 1 }, { isAccepted: 1 }]
      },
      "campaignId"
    ).lean();

    const excludedIds = new Set(
      contracted.map((c) => String(c.campaignId || "").trim()).filter(Boolean)
    );

    campaignIds = campaignIds.filter((id) => !excludedIds.has(id));

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0
        },
        campaigns: []
      });
    }

    // ✅ campaignId may be stored as Campaign._id OR Campaign.campaignsId
    const campaignObjectIds = campaignIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    const campaignIdFilter = {
      $or: [
        { campaignsId: { $in: campaignIds } },
        ...(campaignObjectIds.length ? [{ _id: { $in: campaignObjectIds } }] : [])
      ]
    };

    const filter =
      search && String(search).trim()
        ? {
          $and: [campaignIdFilter, { $or: buildSearchOr(String(search).trim()) }]
        }
        : campaignIdFilter;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter, "-description")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean()
    ]);

    return res.status(200).json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit)
      },
      campaigns: rawCampaigns.map(({ description, ...c }) => ({
        ...c,
        hasApplied: 1,
        hasApproved: 0,
        isContracted: 0,
        contractId: null,
        isAccepted: 0
      }))
    });
  } catch (err) {
    console.error("getAppliedCampaignsByInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
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

    const filter = { _id: { $in: campaignIds } };
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
        totalAcceptedMembers: signedCountByCampaign.get(String(camp._id)) || 0, applicantCount: Math.max(0, (Number(camp.applicantCount) || 0)),
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAcceptedInfluencers = async (req, res) => {
  try {
    const source = req.method === "GET" ? req.query : (req.body || {});

    const {
      campaignId,
      search = "",
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
    } = source;

    if (!campaignId) {
      return res.status(400).json({ message: "campaignId required" });
    }

    const contracts = await Contract.find(
      {
        ...buildContractCampaignFilter(campaignId),
        isRejected: { $ne: 1 },
        status: {
          $in: [
            CONTRACT_STATUS.CONTRACT_SIGNED,
            CONTRACT_STATUS.MILESTONES_CREATED,
          ],
        },
        $or: [
          { supersededBy: { $exists: false } },
          { supersededBy: null },
          { supersededBy: "" },
        ],
      },
      "influencerId contractId feeAmount lastActionAt createdAt updatedAt status"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const influencerIds = contracts.map((c) => String(c.influencerId));
    if (!influencerIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0,
        },
        influencers: [],
      });
    }

    const contractMap = new Map();
    const feeMap = new Map();

    for (const c of contracts) {
      const key = String(c.influencerId);
      if (!contractMap.has(key)) {
        contractMap.set(key, c.contractId || null);
        feeMap.set(key, Number(c.feeAmount || 0));
      }
    }

    const filter = {
      influencerId: { $in: Array.from(contractMap.keys()) },
    };

    if (String(search).trim()) {
      filter.$or = [
        { name: new RegExp(String(search).trim(), "i") },
        { handle: new RegExp(String(search).trim(), "i") },
        { email: new RegExp(String(search).trim(), "i") },
      ];
    }

    const sortField =
      {
        createdAt: "createdAt",
        updatedAt: "updatedAt",
        name: "name",
        followerCount: "followerCount",
        feeAmount: "feeAmount",
      }[sortBy] || "createdAt";

    const sortDir = String(order).toLowerCase() === "asc" ? 1 : -1;
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .sort(sortField === "feeAmount" ? {} : { [sortField]: sortDir })
        .skip(skip)
        .limit(safeLimit)
        .select("-passwordHash -__v")
        .lean(),
    ]);

    if (!rawInfluencers.length) {
      return res.json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        influencers: [],
      });
    }

    const modashProfiles = await Modash.find(
      {
        influencerId: {
          $in: rawInfluencers.map((i) => String(i.influencerId)),
        },
      },
      "influencerId username handle followers provider"
    ).lean();

    const modashByInfluencerId = new Map();
    for (const m of modashProfiles) {
      const key = String(m.influencerId);
      if (!modashByInfluencerId.has(key)) {
        modashByInfluencerId.set(key, []);
      }
      modashByInfluencerId.get(key).push(m);
    }

    function pickPrimaryProfile(influencerDoc, profilesForInfluencer) {
      if (!profilesForInfluencer?.length) return null;

      const primaryPlatform = String(
        influencerDoc.primaryPlatform || ""
      ).toLowerCase();

      if (["youtube", "instagram", "tiktok"].includes(primaryPlatform)) {
        const direct = profilesForInfluencer.find(
          (p) => String(p.provider || "").toLowerCase() === primaryPlatform
        );
        if (direct) return direct;
      }

      return profilesForInfluencer.reduce((best, current) =>
        Number(current?.followers || 0) > Number(best?.followers || 0)
          ? current
          : best
      );
    }

    let influencers = rawInfluencers.map((inf) => {
      const key = String(inf.influencerId);
      const primaryProfile = pickPrimaryProfile(
        inf,
        modashByInfluencerId.get(key) || []
      );

      return {
        ...inf,
        contractId: contractMap.get(key) || null,
        feeAmount: feeMap.get(key) || 0,
        isAccepted: 1,
        socialHandle:
          (primaryProfile &&
            (primaryProfile.username || primaryProfile.handle)) ||
          inf.handle ||
          null,
        audienceSize:
          primaryProfile && typeof primaryProfile.followers === "number"
            ? primaryProfile.followers
            : typeof inf.followerCount === "number"
              ? inf.followerCount
              : 0,
        primaryPlatform: inf.primaryPlatform || null,
        primaryProvider: primaryProfile ? primaryProfile.provider : null,
      };
    });

    if (sortField === "feeAmount") {
      influencers.sort((a, b) =>
        sortDir === 1 ? a.feeAmount - b.feeAmount : b.feeAmount - a.feeAmount
      );
    }

    return res.json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      influencers,
    });
  } catch (err) {
    console.error("getAcceptedInfluencers error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
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
    const campaignId = req.query.id || req.params?.id;
    if (!campaignId) return res.status(400).json({ message: "Query parameter id is required." });
    if (!isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId, "campaignTitle campaignBudget budget timeline paymentType").lean();
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    return res.json({
      campaignName: campaign.campaignTitle,
      budget: campaign.campaignBudget ?? campaign.budget ?? 0,
      timeline: campaign.timeline || {},
      paymentType: campaign.paymentType
    });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getDraftCampaignByBrand = async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId || !isOid(brandId)) return res.status(400).json({ message: "brandId is required as a query param." });
    const draft = await Campaign.findOne({ brandId: toObjectId(brandId), isDraft: 1 }).sort({ updatedAt: -1 }).lean();
    if (!draft) return res.status(201).json({ message: "No draft found for this brand." });
    return res.status(200).json(draft);
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.getCampaignHistoryByBrand = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      search = "",
      sortBy = "createdAt",
      sortOrder = "desc",
      includeDescription = 1,

      campaignStatus,
      timelineState,
      goal,
      minBudget,
      maxBudget,

      campaignType,
      creatorStatus,
      categoryIds,
      aiCreated,

      quickFilter,
      allDatesOption,
      startDate,
      endDate,
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required." });
    }

    const filter = {
      brandId,
      isDraft: { $ne: 1 },
    };

    const andClauses = [];

    if (search && String(search).trim()) {
      andClauses.push({
        $or: buildSearchOr(String(search).trim()),
      });
    }

    if (
      campaignStatus &&
      ["open", "paused"].includes(String(campaignStatus).toLowerCase().trim())
    ) {
      filter.campaignStatus = String(campaignStatus).toLowerCase().trim();
    }

    if (goal) {
      filter.goal = String(goal);
    }

    if (campaignType && String(campaignType).trim() && String(campaignType) !== "all") {
      andClauses.push({
        $or: [
          { campaignType: String(campaignType).trim() },
          { type: String(campaignType).trim() },
        ],
      });
    }

    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      const cleanCategoryIds = categoryIds.map(String).filter(Boolean);

      andClauses.push({
        $or: [
          { categoryId: { $in: cleanCategoryIds } },
          { campaignCategoryId: { $in: cleanCategoryIds } },
          { "categories.categoryId": { $in: cleanCategoryIds } },
          { "categories._id": { $in: cleanCategoryIds } },
        ],
      });
    }

    if (aiCreated === true || aiCreated === 1 || aiCreated === "true") {
      andClauses.push({
        $or: [
          { aiCreated: true },
          { isAiCreated: true },
          { createdByAI: true },
        ],
      });
    }

    if (minBudget !== undefined || maxBudget !== undefined) {
      filter.budget = {};

      if (
        minBudget !== undefined &&
        minBudget !== null &&
        String(minBudget).trim() !== "" &&
        Number.isFinite(Number(minBudget))
      ) {
        filter.budget.$gte = Number(minBudget);
      }

      if (
        maxBudget !== undefined &&
        maxBudget !== null &&
        String(maxBudget).trim() !== "" &&
        Number.isFinite(Number(maxBudget))
      ) {
        filter.budget.$lte = Number(maxBudget);
      }

      if (!Object.keys(filter.budget).length) {
        delete filter.budget;
      }
    }

    const now = new Date();

    function startOfDayUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    }

    function endOfDayUTC(date) {
      return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999)
      );
    }

    function addDaysUTC(date, days) {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }

    function startOfWeekUTC(date) {
      const d = startOfDayUTC(date);
      const day = d.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      return addDaysUTC(d, diff);
    }

    function endOfWeekUTC(date) {
      return endOfDayUTC(addDaysUTC(startOfWeekUTC(date), 6));
    }

    function startOfMonthUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    }

    function endOfMonthUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    }

    function parseDateInput(v, endOfDay = false) {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return null;
      return endOfDay ? endOfDayUTC(d) : startOfDayUTC(d);
    }

    const startOfToday = startOfDayUTC(now);

    if (timelineState) {
      const state = String(timelineState).toLowerCase().trim();

      if (state === "none") {
        andClauses.push({
          $and: [
            {
              $or: [
                { "timeline.startDate": { $exists: false } },
                { "timeline.startDate": null },
              ],
            },
            {
              $or: [
                { "timeline.endDate": { $exists: false } },
                { "timeline.endDate": null },
              ],
            },
          ],
        });
      } else if (state === "expired") {
        andClauses.push({
          "timeline.endDate": { $exists: true, $ne: null, $lt: startOfToday },
        });
      } else if (state === "running") {
        andClauses.push({
          $and: [
            {
              $or: [
                { "timeline.startDate": { $exists: true, $ne: null } },
                { "timeline.endDate": { $exists: true, $ne: null } },
              ],
            },
            {
              $or: [
                { "timeline.endDate": { $exists: false } },
                { "timeline.endDate": null },
                { "timeline.endDate": { $gte: startOfToday } },
              ],
            },
          ],
        });
      }
    }

    if (quickFilter) {
      const qf = String(quickFilter).trim();

      if (qf === "recently_edited") {
        andClauses.push({
          updatedAt: { $gte: addDaysUTC(startOfToday, -7) },
        });
      } else if (qf === "launching_soon") {
        andClauses.push({
          "timeline.startDate": {
            $gte: startOfToday,
            $lte: endOfDayUTC(addDaysUTC(startOfToday, 14)),
          },
        });
      } else if (qf === "today") {
        andClauses.push({
          createdAt: {
            $gte: startOfToday,
            $lte: endOfDayUTC(startOfToday),
          },
        });
      } else if (qf === "this_week") {
        andClauses.push({
          createdAt: {
            $gte: startOfWeekUTC(now),
            $lte: endOfWeekUTC(now),
          },
        });
      } else if (qf === "this_month") {
        andClauses.push({
          createdAt: {
            $gte: startOfMonthUTC(now),
            $lte: endOfMonthUTC(now),
          },
        });
      }
    } else if (allDatesOption && String(allDatesOption) !== "all") {
      let rangeStart = null;
      let rangeEnd = endOfDayUTC(now);
      const opt = String(allDatesOption).trim();

      if (opt === "last_7") rangeStart = addDaysUTC(startOfToday, -7);
      if (opt === "last_15") rangeStart = addDaysUTC(startOfToday, -15);
      if (opt === "last_30") rangeStart = addDaysUTC(startOfToday, -30);
      if (opt === "last_90") rangeStart = addDaysUTC(startOfToday, -90);
      if (opt === "last_365") rangeStart = addDaysUTC(startOfToday, -365);

      if (opt === "last_month") {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        rangeStart = startOfMonthUTC(d);
        rangeEnd = endOfMonthUTC(d);
      }

      if (opt === "last_quarter") {
        const currentQuarter = Math.floor(now.getUTCMonth() / 3);
        const lastQuarterEndMonth = currentQuarter * 3 - 1;
        const year = lastQuarterEndMonth < 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
        const normalizedEndMonth = lastQuarterEndMonth < 0 ? 11 : lastQuarterEndMonth;
        const startMonth = normalizedEndMonth - 2;

        rangeStart = new Date(Date.UTC(year, startMonth, 1));
        rangeEnd = new Date(Date.UTC(year, normalizedEndMonth + 1, 0, 23, 59, 59, 999));
      }

      if (rangeStart && rangeEnd) {
        andClauses.push({
          createdAt: {
            $gte: rangeStart,
            $lte: rangeEnd,
          },
        });
      }
    } else if (startDate || endDate) {
      const range = {};
      const parsedStart = parseDateInput(startDate, false);
      const parsedEnd = parseDateInput(endDate, true);

      if (parsedStart) range.$gte = parsedStart;
      if (parsedEnd) range.$lte = parsedEnd;

      if (Object.keys(range).length) {
        andClauses.push({
          createdAt: range,
        });
      }
    }

    if (creatorStatus && String(creatorStatus).trim() && String(creatorStatus) !== "all") {
      const cs = String(creatorStatus).trim().toLowerCase();

      let contractFilter = { brandId };

      if (cs === "invited") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "invited" },
            { creatorStatus: "invited" },
            { applicationStatus: "invited" },
          ],
        };
      } else if (cs === "applied") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "applied" },
            { creatorStatus: "applied" },
            { applicationStatus: "applied" },
          ],
        };
      } else if (cs === "approved") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "approved" },
            { status: "accepted" },
            { creatorStatus: "approved" },
            { applicationStatus: "approved" },
            activeAcceptedFilter(),
          ],
        };
      }

      const matchedCampaignIds = await Contract.distinct("campaignId", contractFilter);
      const cleanMatchedCampaignIds = matchedCampaignIds.map(String).filter(Boolean);

      if (!cleanMatchedCampaignIds.length) {
        return res.json({
          data: [],
          pagination: {
            total: 0,
            page: Math.max(parseInt(page, 10) || 1, 1),
            limit: Math.max(parseInt(limit, 10) || 10, 1),
            totalPages: 0,
          },
        });
      }

      filter.$expr = {
        $in: [{ $toString: "$_id" }, cleanMatchedCampaignIds],
      };
    }

    if (andClauses.length) {
      filter.$and = andClauses;
    }

    const sortFieldMap = {
      createdAt: "createdAt",
      budget: "budget",
      applicantCount: "applicantCount",
      campaignStatus: "campaignStatus",
      statusUpdatedAt: "statusUpdatedAt",
      productOrServiceName: "productOrServiceName",
      isActive: "isActive",
    };

    const sortObj = {
      [sortFieldMap[sortBy] || "createdAt"]:
        String(sortOrder).toLowerCase() === "asc" ? 1 : -1,
    };

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.max(parseInt(limit, 10) || 10, 1);
    const skip = (safePage - 1) * safeLimit;

    const [rows, total] = await Promise.all([
      Campaign.find(
        filter,
        Number(includeDescription) === 1 ? undefined : "-description"
      )
        .sort(sortObj)
        .skip(skip)
        .limit(safeLimit)
        .lean(),

      Campaign.countDocuments(filter),
    ]);

    const workingIds = await Contract.distinct("campaignId", {
      brandId,
      campaignId: { $in: rows.map((c) => String(c._id)) },
      ...activeAcceptedFilter(),
    });

    const workingSet = new Set(workingIds.map(String));

    return res.json({
      data: rows.map((c) => {
        const tl = c.timeline || {};
        const state =
          !tl.startDate && !tl.endDate
            ? "none"
            : tl.endDate && new Date(tl.endDate) < startOfToday
              ? "expired"
              : "running";

        return {
          ...c,
          computedIsActive: computeIsActive(c.timeline),
          timelineState: state,
          hasTimeline: state !== "none",
          influencerWorking:
            workingSet.has(String(c._id)) || workingSet.has(String(String(c._id) || "")),
        };
      }),
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("getCampaignHistoryByBrand error:", error);
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
    const reviewer = await resolveAdminActor(req);
    Object.assign(campaign, campaign.pendingUpdate.patch);
    campaign.pendingUpdate = {
      status: "approved",
      patch: null,
      updatedBy: campaign.pendingUpdate.updatedBy,
      updatedAt: campaign.pendingUpdate.updatedAt,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: String(req.body?.note || ""),
    };
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
    const reviewer = await resolveAdminActor(req);
    campaign.pendingUpdate = {
      status: "rejected",
      patch: null,
      updatedBy: campaign.pendingUpdate.updatedBy,
      updatedAt: campaign.pendingUpdate.updatedAt,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: note,
    };
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

    const includeDrafts = String(req.query.includeDrafts || "0") === "1";

    const filter = {
      ...(brandId && isOid(brandId) ? { brandId: toObjectId(brandId) } : {}),
      $or: [
        { "createdBy.role": "admin" },
        { "createdBy.role": { $regex: /^admin$/i } },
        { approvalMode: "admin_review" },
      ],
      ...(includeDrafts ? {} : { isDraft: { $ne: 1 } }),
    };

    const [data, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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

    const data = await Category.find(filter).sort({ name: 1 }).lean();

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

      const cat = await Category.findById(categoryId)
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

    const data = await Category.aggregate(pipeline);
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
      user.brandId || user.id || user._id || user.userId || ""
    ).trim();

    if (!tokenBrandRaw) {
      return fail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Invalid brand token",
        requestId
      );
    }

    const tokenBrandDoc = await findBrandDocByAnyId(tokenBrandRaw);

    if (!tokenBrandDoc) {
      return fail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Brand not found from token",
        requestId
      );
    }

    const campaignId = clean(req.body.campaignId);

    if (!campaignId || !isOid(campaignId)) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "Valid campaignId is required",
        requestId
      );
    }

    const filter = buildCampaignLookupFilter(campaignId, tokenBrandDoc._id);

    if (!filter) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "Valid campaignId is required",
        requestId
      );
    }

    const campaign = await Campaign.findOne(filter).lean();

    if (!campaign) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Campaign not found",
        requestId
      );
    }

    const applyCampaign = await ApplyCampaign.findOne({
      campaignId: campaignId,
    }).lean();

    const count = applyCampaign?.applicants?.length || 0;

    campaign.count = count;

    const enriched = (await enrichCampaigns([campaign]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { doc: enriched },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

exports.getRecommendedInfluencersByCampaignId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandIdRaw = clean(req.body.brandId);
    if (!brandIdRaw || !Types.ObjectId.isValid(brandIdRaw)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const campaignIdRaw = clean(req.body.campaignId);
    if (!campaignIdRaw) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    const brandObjectId = new Types.ObjectId(brandIdRaw);

    const campaignOr = [];

    // support Mongo _id
    if (Types.ObjectId.isValid(campaignIdRaw)) {
      campaignOr.push({ _id: new Types.ObjectId(campaignIdRaw) });
    }

    // support legacy campaignsId
    campaignOr.push({ campaignsId: campaignIdRaw });

    const campaign = await Campaign.findOne({
      $and: [
        { $or: campaignOr },
        {
          $or: [
            { brandId: brandObjectId },   // if stored as ObjectId
            { brandId: brandIdRaw },      // if stored as string
          ],
        },
      ],
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
        campaignId: String(campaign._id),
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

    const allowedStatuses = ["draft", "scheduled", "active", "paused", "completed", "archived"];

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
      "_id status brandId publishedAt endAt scheduledAt scheduledLocation endedAt isActive isDraft publishStatus statusUpdatedAt pausedAt"
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
      return fail(res, 400, "VALIDATION_ERROR", `Campaign is already in '${newStatus}' status`, requestId);
    }

    if (currentStatus === "completed") {
      return fail(res, 400, "VALIDATION_ERROR", "Completed campaign status cannot be changed", requestId);
    }

    if (currentStatus === "archived") {
      return fail(res, 400, "VALIDATION_ERROR", "Archived campaign status cannot be changed", requestId);
    }


    if (newStatus === "scheduled" && currentStatus !== "draft") {
      return fail(res, 400, "VALIDATION_ERROR", "Only draft campaigns can be moved to scheduled", requestId);
    }

    if (newStatus === "draft" && currentStatus !== "scheduled") {
      return fail(res, 400, "VALIDATION_ERROR", "Only scheduled campaigns can be reverted to draft", requestId);
    }

    existing.status = newStatus;
    existing.statusUpdatedAt = new Date();

    existing.isDraft = newStatus === "draft" ? 1 : 0;
    existing.isActive = newStatus === "active" ? 1 : 0;

    if (newStatus === "draft") {
      existing.publishStatus = "draft";
      existing.publishedAt = null;
      existing.scheduledAt = null;
      existing.scheduledLocation = null;
      existing.pausedAt = null;
    }

    if (newStatus === "scheduled") {
      existing.publishStatus = "published";
      existing.publishedAt = null;
      existing.isActive = 0;
      existing.pausedAt = null;
    }

    if (newStatus === "active") {
      existing.publishStatus = "published";
      existing.publishedAt = existing.publishedAt || new Date();
      existing.scheduledAt = null;
      existing.scheduledLocation = null;
      existing.pausedAt = null;
    }

    if (newStatus === "paused") {
      existing.publishStatus = "published";
      existing.pausedAt = new Date();
    }

    if (newStatus === "completed") {
      existing.publishStatus = "published";
      existing.isActive = 0;
      existing.endedAt = existing.endedAt || new Date();
      existing.pausedAt = existing.pausedAt || new Date();
    }

    if (newStatus === "archived") {
      existing.publishStatus = "published";
      existing.isActive = 0;
      existing.pausedAt = existing.pausedAt || new Date();
    }

    await existing.save();

    return ApiResponse.sendOk(res, 200, { message: "Status updated successfully" }, requestId);
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
    if (!isOid(campaignId)) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignId", requestId, "Valid campaignId is required");
    }

    const filter = buildCampaignLookupFilter(campaignId, brandDoc._id);
    const existingCampaign = await Campaign.findOne(filter);

    if (!existingCampaign) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Campaign not found", requestId);
    }

    const campaignTz = getCampaignTimezone(req.body, existingCampaign.campaignTimezone);
    req.body.campaignTimezone = campaignTz;

    const status = pickStatus(req.body.status || existingCampaign.status || "active");
    const mode = status === "draft" ? "draft" : "publish";

    const v = await validateForMode(res, requestId, mode, req.body, {
      existingProductImages: existingCampaign.productImages || [],
    });
    if (!v.ok) return v.resp;

    let timing = {};

    if (status === "draft") {
      timing = parseDraftWindowSoft(req.body, campaignTz);
    } else {
      const win = parseCampaignWindowForUpdate(req.body, campaignTz, requestId, res, {
        allowPastStart: true,
      });
      if (!win.ok) return win.resp;
      timing = win.value;
    }

    const rel = await resolveCategoryAndSubcategories(clean(req.body.categoryId), normalizeObjectIdArray(req.body.subcategoryIds));
    if (rel.error) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId, rel.error);
    }

    let normalizedProductImages = existingCampaign.productImages || [];

    if (req.body.productImages !== undefined) {
      normalizedProductImages = await normalizeAndUploadProductImages(
        req.body.productImages
      );
    }

    const mergedBody = {
      ...req.body,
      productImages: normalizedProductImages,
    };

    const patch = buildCampaignUpdatePatch(mergedBody, existingCampaign, status, timing, {
      categoryName: rel?.cat?.name || "",
      subcategoryNames: Array.isArray(rel?.subs) ? rel.subs.map((s) => String(s.name || "")) : [],
    });

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

function buildCampaignLookupForInfluencerView(campaignId) {
  const raw = clean(campaignId);
  if (!isOid(raw)) return null;
  return { _id: toObjectId(raw) };
}

exports.viewCampaignByIdForInfluencer = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const influencerIdRaw = clean(req.body.influencerId);
    if (!influencerIdRaw) {
      return fail(res, 400, "VALIDATION_ERROR", "influencerId is required", requestId);
    }

    // support both Mongo _id and custom influencerId
    const influencerLookup = mongoose.Types.ObjectId.isValid(influencerIdRaw)
      ? {
        $or: [
          { _id: influencerIdRaw },
          { influencerId: influencerIdRaw }
        ]
      }
      : { influencerId: influencerIdRaw };

    const influencerDoc = await Influencer.findOne(influencerLookup)
      .select("_id influencerId name")
      .lean();

    if (!influencerDoc) {
      return fail(res, 404, "NOT_FOUND", "Influencer not found", requestId);
    }

    const internalInfluencerId = String(influencerDoc._id);
    const publicInfluencerId = String(influencerDoc.influencerId || influencerDoc._id);

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    if (!isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const filter = buildCampaignLookupForInfluencerView(campaignId);
    if (!filter) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne(filter).lean();
    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    const campaignObjectId = String(campaign._id);
    const campaignLegacyId = String(campaign.campaignsId || "").trim();

    const hasApplied = await ApplyCampaign.exists({
      $and: [
        {
          $or: [
            { campaignId: campaignObjectId },
            ...(campaignLegacyId ? [{ campaignId: campaignLegacyId }] : [])
          ]
        },
        {
          $or: [
            { "applicants.influencerId": internalInfluencerId },
            { "applicants.influencerId": publicInfluencerId }
          ]
        }
      ]
    });

    const contract = await Contract.findOne(
      {
        $and: [
          {
            $or: [
              { campaignId: campaignObjectId },
              ...(campaignLegacyId ? [{ campaignId: campaignLegacyId }] : [])
            ]
          },
          {
            influencerId: { $in: [internalInfluencerId, publicInfluencerId] }
          }
        ]
      },
      "contractId isAccepted isAssigned status"
    ).lean();

    const enriched = (await enrichCampaigns([campaign]))[0];

    const doc = {
      ...enriched,
      hasApplied: hasApplied ? 1 : 0,
      hasApproved: contract?.isAssigned === 1 ? 1 : 0,
      isContracted: contract ? 1 : 0,
      isAccepted: contract?.isAccepted === 1 ? 1 : 0,
      contractId: contract?.contractId || null
    };

    return ApiResponse.sendOk(res, 200, { doc }, requestId);
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

exports.getAllActiveCampaignsForInfluencer = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const { influencerId, page = 1, limit = 10, search = "" } = req.body || {};

    if (!influencerId) {
      return fail(res, 400, "VALIDATION_ERROR", "influencerId is required", requestId);
    }

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const influencerLookup = mongoose.Types.ObjectId.isValid(String(influencerId))
      ? {
          $or: [
            { _id: influencerId },
            { influencerId: String(influencerId) }
          ]
        }
      : { influencerId: String(influencerId) };

    const influencer = await Influencer.findOne(
      influencerLookup,
      "_id influencerId"
    ).lean();

    if (!influencer) {
      return fail(res, 404, "NOT_FOUND", "Influencer not found", requestId);
    }

    const internalInfluencerId = String(influencer._id);
    const publicInfluencerId = String(influencer.influencerId || influencer._id);

    const appliedDocs = await ApplyCampaign.find(
      {
        $or: [
          { "applicants.influencerId": internalInfluencerId },
          { "applicants.influencerId": publicInfluencerId }
        ]
      },
      "campaignId"
    ).lean();

    const appliedCampaignIds = [
      ...new Set(
        appliedDocs
          .map((doc) => String(doc.campaignId || "").trim())
          .filter(Boolean)
      )
    ];

    const appliedObjectIds = appliedCampaignIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    const filter = {
      status: "active",
      isActive: 1,
      isDraft: { $ne: 1 }
    };

    if (appliedCampaignIds.length) {
      filter.$and = [
        {
          $nor: [
            { campaignsId: { $in: appliedCampaignIds } },
            ...(appliedObjectIds.length ? [{ _id: { $in: appliedObjectIds } }] : [])
          ]
        }
      ];
    }

    if (search && String(search).trim()) {
      const searchClause = { $or: buildSearchOr(String(search).trim()) };

      if (filter.$and) {
        filter.$and.push(searchClause);
      } else {
        filter.$and = [searchClause];
      }
    }

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .populate({
          path: "campaignGoals",
          select: "_id goal"
        })
        .populate({
          path: "targetCountryIds",
          select: "_id name countryName code isoCode flag"
        })
        .populate({
          path: "targetAgeRanges",
          select: "_id range"
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean()
    ]);

    return ApiResponse.sendOk(
      res,
      200,
      {
        items: campaigns,
        pagination: {
          total,
          page: safePage,
          limit: safeLimit,
          totalPages: Math.ceil(total / safeLimit)
        }
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};

exports.getCampaignsByBrandId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    if (!brandId || !isOid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const tz = getCampaignTimezone(req.body);
    const nowUtc = DateTime.utc();

    await Campaign.updateMany(
      {
        brandId: toObjectId(brandId),
        status: "scheduled",
        scheduledAt: { $lte: nowUtc.toJSDate() },
      },
      {
        $set: {
          status: "active",
          isActive: 1,
          publishedAt: nowUtc.toJSDate(),
        },
      }
    );

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 20, 1, 200);
    const skip = (page - 1) * limit;

    // ---------------- helpers ----------------
    const escapeRegexLocal = (s = "") =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const normalizeDateField = (value) => {
      const raw = clean(value);
      const allowed = ["createdAt", "updatedAt", "scheduledAt", "startAt", "endAt", "publishedAt"];
      return allowed.includes(raw) ? raw : "createdAt";
    };

    const normalizeDatePreset = (value) => {
      const raw = clean(value).toLowerCase().replace(/\s+/g, "");
      const map = {
        today: "today",
        thisweek: "thisWeek",
        thismonth: "thisMonth",
        last7days: "last7days",
        last7day: "last7days",
        last15days: "last15days",
        last15day: "last15days",
        last30days: "last30days",
        last30day: "last30days",
        last90days: "last90days",
        last90day: "last90days",
        lastmonth: "lastMonth",
        lastquarter: "lastQuarter",
        last365days: "last365days",
        last365day: "last365days",
        next7days: "next7days",
        next7day: "next7days",
        next15days: "next15days",
        next15day: "next15days",
        next30days: "next30days",
        next30day: "next30days",
        next90days: "next90days",
        next90day: "next90days",
        launchingsoon: "launchingSoon",
        launchsoon: "launchingSoon",
      };
      if (!raw || raw === "all" || raw === "alldates") return "";
      return map[raw] || "";
    };

    const parseClientDateToUtc = (raw, timezone, boundary = "start") => {
      const s = clean(raw);
      if (!s) return null;

      // dd/mm/yyyy
      const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
      const m = s.match(ddmmyyyy);
      if (m) {
        const [, dd, mm, yyyy] = m;
        const dt = DateTime.fromObject(
          {
            year: Number(yyyy),
            month: Number(mm),
            day: Number(dd),
            hour: boundary === "end" ? 23 : 0,
            minute: boundary === "end" ? 59 : 0,
            second: boundary === "end" ? 59 : 0,
            millisecond: boundary === "end" ? 999 : 0,
          },
          { zone: timezone }
        );
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      // yyyy-mm-dd
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (isoDate.test(s)) {
        const dt = DateTime.fromISO(s, { zone: timezone }).set({
          hour: boundary === "end" ? 23 : 0,
          minute: boundary === "end" ? 59 : 0,
          second: boundary === "end" ? 59 : 0,
          millisecond: boundary === "end" ? 999 : 0,
        });
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      // ISO datetime / absolute
      const abs = toUtcFromLocalOrAbsolute(s, timezone);
      if (!abs) return null;

      if (s.length <= 10) {
        const dt = DateTime.fromJSDate(abs, { zone: timezone }).set({
          hour: boundary === "end" ? 23 : 0,
          minute: boundary === "end" ? 59 : 0,
          second: boundary === "end" ? 59 : 0,
          millisecond: boundary === "end" ? 999 : 0,
        });
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      return abs;
    };

    const buildUtcRangeFromPreset = (preset, timezone) => {
      const nowLocal = DateTime.now().setZone(timezone || "UTC");
      const startOfToday = nowLocal.startOf("day");
      const endOfToday = nowLocal.endOf("day");

      const lastNDays = (n) => ({
        from: nowLocal.minus({ days: n - 1 }).startOf("day").toUTC().toJSDate(),
        to: endOfToday.toUTC().toJSDate(),
      });

      const nextNDays = (n) => ({
        from: startOfToday.toUTC().toJSDate(),
        to: nowLocal.plus({ days: n - 1 }).endOf("day").toUTC().toJSDate(),
      });

      if (preset === "today") {
        return {
          from: startOfToday.toUTC().toJSDate(),
          to: endOfToday.toUTC().toJSDate(),
        };
      }

      if (preset === "thisWeek") {
        return {
          from: nowLocal.startOf("week").toUTC().toJSDate(),
          to: nowLocal.endOf("week").toUTC().toJSDate(),
        };
      }

      if (preset === "thisMonth") {
        return {
          from: nowLocal.startOf("month").toUTC().toJSDate(),
          to: nowLocal.endOf("month").toUTC().toJSDate(),
        };
      }

      if (preset === "last7days") return lastNDays(7);
      if (preset === "last15days") return lastNDays(15);
      if (preset === "last30days") return lastNDays(30);
      if (preset === "last90days") return lastNDays(90);
      if (preset === "last365days") return lastNDays(365);

      if (preset === "lastMonth") {
        const m = nowLocal.minus({ months: 1 });
        return {
          from: m.startOf("month").toUTC().toJSDate(),
          to: m.endOf("month").toUTC().toJSDate(),
        };
      }

      if (preset === "lastQuarter") {
        const q = Math.ceil(nowLocal.month / 3);
        const prevQ = q === 1 ? 4 : q - 1;
        const year = q === 1 ? nowLocal.year - 1 : nowLocal.year;
        const startMonth = (prevQ - 1) * 3 + 1;

        const start = DateTime.fromObject(
          { year, month: startMonth, day: 1 },
          { zone: timezone }
        ).startOf("day");

        const end = start.plus({ months: 3 }).minus({ days: 1 }).endOf("day");

        return { from: start.toUTC().toJSDate(), to: end.toUTC().toJSDate() };
      }

      if (preset === "next7days") return nextNDays(7);
      if (preset === "next15days") return nextNDays(15);
      if (preset === "next30days") return nextNDays(30);
      if (preset === "next90days") return nextNDays(90);

      return null;
    };

    const buildSort = (sortByRaw, sortOrderRaw, fallback = { updatedAt: -1 }) => {
      const allowed = [
        "createdAt",
        "updatedAt",
        "startAt",
        "endAt",
        "publishedAt",
        "campaignTitle",
        "campaignBudget",
        "numberOfInfluencers",
        "status",
      ];

      const sortBy = clean(sortByRaw);
      const sortOrder = String(sortOrderRaw || "desc").toLowerCase() === "asc" ? 1 : -1;

      if (!allowed.includes(sortBy)) return fallback;
      return { [sortBy]: sortOrder };
    };

    const timeRemaining = (targetDate, now, expiredText = "Expired") => {
      if (!targetDate) return { unit: null, value: null, text: null };

      const target = DateTime.fromJSDate(new Date(targetDate)).toUTC();
      if (!target.isValid) return { unit: null, value: null, text: null };

      const diffMs = target.toMillis() - now.toMillis();
      if (diffMs <= 0) {
        return { unit: "expired", value: 0, text: expiredText };
      }

      const totalSeconds = Math.floor(diffMs / 1000);
      const totalMinutes = Math.floor(diffMs / (1000 * 60));
      const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
      const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (totalSeconds < 60) {
        return {
          unit: "seconds",
          value: totalSeconds,
          text: `${totalSeconds}s left`,
        };
      }

      if (totalMinutes < 60) {
        const seconds = totalSeconds % 60;
        return {
          unit: "minutes",
          value: totalMinutes,
          text: seconds > 0 ? `${totalMinutes}m ${seconds}s left` : `${totalMinutes}m left`,
        };
      }

      if (totalHours < 24) {
        const minutes = totalMinutes % 60;
        return {
          unit: "hours",
          value: totalHours,
          text: minutes > 0 ? `${totalHours}h ${minutes}m left` : `${totalHours}h left`,
        };
      }

      return {
        unit: "days",
        value: totalDays,
        text: `${totalDays}d left`,
      };
    };

    // ---------------- Build filter ----------------
    const filter = {
      brandId: toObjectId(brandId),
    };

    // search
    const search = clean(req.body.search);
    if (search) {
      filter.$or = buildSearchOr(search);
    }

    // byAi
    if (req.body.byAi === 0 || req.body.byAi === 1 || req.body.byAi === "0" || req.body.byAi === "1") {
      filter.byAi = Number(req.body.byAi);
    }

    // status
    if (clean(req.body.status)) {
      filter.status = pickStatus(req.body.status);
    }

    // campaignType
    if (clean(req.body.campaignType)) {
      filter.campaignType = {
        $regex: new RegExp(escapeRegexLocal(clean(req.body.campaignType)), "i"),
      };
    }

    // categoryIds / categoryId
    const catIds = normalizeObjectIdArray(req.body.categoryIds ?? req.body.categoryId);
    if (catIds.length) {
      filter.categoryId = { $in: catIds.map((id) => toObjectId(id)) };
    }

    // subcategoryIds / subcategoryId
    const subIds = normalizeObjectIdArray(req.body.subcategoryIds ?? req.body.subcategoryId);
    if (subIds.length) {
      filter.subcategoryIds = { $in: subIds.map((id) => toObjectId(id)) };
    }

    // date filters
    const dateField = normalizeDateField(req.body.dateField);
    const preset = normalizeDatePreset(req.body.datePreset);

    if (preset === "launchingSoon") {
      filter.status = "scheduled";
      filter.scheduledAt = {
        $exists: true,
        $ne: null,
        $gte: DateTime.utc().toJSDate(),
      };
    } else if (preset) {
      const range = buildUtcRangeFromPreset(preset, tz);
      if (range) {
        filter[dateField] = { $gte: range.from, $lte: range.to };
      }
    } else {
      const hasFrom = !!clean(req.body.dateFrom);
      const hasTo = !!clean(req.body.dateTo);

      const fromUtc = hasFrom ? parseClientDateToUtc(req.body.dateFrom, tz, "start") : null;
      const toUtc = hasTo ? parseClientDateToUtc(req.body.dateTo, tz, "end") : null;

      if (hasFrom && !fromUtc) {
        return failField(
          res,
          400,
          "VALIDATION_ERROR",
          "dateFrom",
          requestId,
          "Invalid dateFrom. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (hasTo && !toUtc) {
        return failField(
          res,
          400,
          "VALIDATION_ERROR",
          "dateTo",
          requestId,
          "Invalid dateTo. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (fromUtc || toUtc) {
        if (fromUtc && toUtc && fromUtc.getTime() > toUtc.getTime()) {
          return fail(res, 400, "VALIDATION_ERROR", "dateFrom must be <= dateTo", requestId);
        }

        filter[dateField] = {};
        if (fromUtc) filter[dateField].$gte = fromUtc;
        if (toUtc) filter[dateField].$lte = toUtc;
      }
    }

    const sort = buildSort(req.body.sortBy, req.body.sortOrder, { updatedAt: -1 });

    // ---------------- Fetch campaigns ----------------
    const [items, total] = await Promise.all([
      Campaign.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .select(
          [
            "_id",
            "campaignTitle",
            "status",
            "categoryId",
            "subcategoryIds",
            "numberOfInfluencers",
            "platformSelection",
            "productImages",
            "createdAt",
            "updatedAt",
            "scheduledAt",
            "startAt",
            "endAt",
            "publishedAt",
            "campaignBudget",
            "byAi",
            "isActive",
            "isDraft",
            "createdBy",
          ].join(" ")
        )
        .lean(),
      Campaign.countDocuments(filter),
    ]);

    // ---------------- Category map ----------------
    const categoryIds = [
      ...new Set(
        items
          .map((x) => String(x.categoryId || ""))
          .filter((x) => isOid(x))
      ),
    ];

    const cats = categoryIds.length
      ? await Category.find({
          _id: { $in: categoryIds.map((id) => toObjectId(id)) },
        })
          .select("_id name")
          .lean()
      : [];

    const catMap = new Map(cats.map((c) => [String(c._id), c]));

    // ---------------- Contract stats ----------------
    const campaignIds = items.map((x) => String(x._id)).filter(Boolean);

    const contractStatsRaw = campaignIds.length
      ? await Contract.aggregate([
          {
            $match: {
              brandId: { $in: [toObjectId(brandId), brandId] },
              campaignId: { $in: campaignIds },
            },
          },
          {
            $group: {
              _id: "$campaignId",
              contractsCount: { $sum: 1 },
              applicantCount: { $sum: 1 },
              acceptedCount: {
                $sum: {
                  $cond: [{ $eq: ["$isAccepted", 1] }, 1, 0],
                },
              },
              assignedCount: {
                $sum: {
                  $cond: [{ $eq: ["$isAssigned", 1] }, 1, 0],
                },
              },
            },
          },
        ])
      : [];

    const contractMap = new Map(
      contractStatsRaw.map((d) => [
        String(d._id),
        {
          contractsCount: Number(d.contractsCount || 0),
          applicantCount: Number(d.applicantCount || 0),
          acceptedCount: Number(d.acceptedCount || 0),
          assignedCount: Number(d.assignedCount || 0),
        },
      ])
    );

    // ---------------- Build response ----------------
    const out = items
      .map((c) => {
        const cid = String(c._id);
        const cat = isOid(String(c.categoryId || "")) ? catMap.get(String(c.categoryId)) : null;
        const contractStats = contractMap.get(cid) || {
          contractsCount: 0,
          applicantCount: 0,
          acceptedCount: 0,
          assignedCount: 0,
        };

        const expireIn = timeRemaining(c.endAt || null, nowUtc, "Expired");
        const rawScheduleIn =
          c.status === "scheduled"
            ? timeRemaining(c.scheduledAt || null, nowUtc, "Expired")
            : { unit: null, value: null, text: null };

        const scheduledJustExpired =
          c.status === "scheduled" &&
          rawScheduleIn &&
          rawScheduleIn.unit === "expired" &&
          Number(rawScheduleIn.value) === 0;

        const effectiveStatus = scheduledJustExpired ? "active" : c.status;

        const scheduleIn = scheduledJustExpired
          ? { unit: null, value: null, text: null }
          : rawScheduleIn;

        const startIn = scheduledJustExpired
          ? { unit: null, value: null, text: null }
          : timeRemaining(c.startAt || null, nowUtc, "Started");

        return {
          campaignId: cid,
          campaignTitle: clean(c.campaignTitle),
          status: effectiveStatus,

          createdAt: c.createdAt ?? null,
          updatedAt: c.updatedAt ?? null,
          publishedAt: scheduledJustExpired
            ? (c.scheduledAt ?? c.publishedAt ?? null)
            : (c.publishedAt ?? null),
          scheduledAt: c.scheduledAt ?? null,
          startAt: c.startAt ?? null,
          endAt: c.endAt ?? null,
          createdBy: c.createdBy ?? null,

          category: cat
            ? { id: String(cat._id), name: String(cat.name || "") }
            : null,

          numberOfInfluencers:
            typeof c.numberOfInfluencers === "number" ? c.numberOfInfluencers : null,

          campaignBudget:
            typeof c.campaignBudget === "number" ? c.campaignBudget : 0,

          applicantCount: contractStats.applicantCount,
          acceptedContracts: contractStats.acceptedCount,
          assignedContracts: contractStats.assignedCount,

          expireIn,
          scheduleIn,
          startIn,

          platformSelection: Array.isArray(c.platformSelection) ? c.platformSelection : [],
          productImages: Array.isArray(c.productImages) ? c.productImages : [],

          byAi: Number(c.byAi || 0),
          isActive: scheduledJustExpired ? 1 : Number(c.isActive || 0),
          isDraft: Number(c.isDraft || 0),
        };
      })
      .filter((item) => {
        const requestedStatus = clean(req.body.status);
        if (!requestedStatus) return true;
        return String(item.status) === requestedStatus;
      });

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


//edit draft campaign - only allows updating certain fields, and only if campaign is still in draft mode

exports.editDraftCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !isOid(brandId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const existing = await Campaign.findOne({
      _id: toObjectId(campaignId),
      brandId: toObjectId(brandId),
      status: "draft",
      isDraft: 1,
    });

    if (!existing) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Draft campaign not found (or not editable)", requestId);
    }

    const campaignTz = getCampaignTimezone(req.body, existing.campaignTimezone);
    const geo = await detectGeoFromRequest(req);

    const update = { $set: {}, $unset: {} };
    const validateView = {}; // keep string/plain values for validateForMode

    const cleanAny = (value) => {
      if (value === undefined || value === null) return "";
      return String(value).trim();
    };

    const setOrUnsetString = (key, value) => {
      if (value === undefined) return;
      const s = cleanAny(value);
      if (!s) {
        update.$unset[key] = 1;
        validateView[key] = undefined;
      } else {
        update.$set[key] = s;
        validateView[key] = s;
      }
    };

    const setOrUnsetIdArray = (key, value) => {
      if (value === undefined) return;
      const ids = normalizeObjectIdArray(value);
      if (!ids.length) {
        update.$unset[key] = 1;
        validateView[key] = [];
      } else {
        update.$set[key] = ids.map((id) => toObjectId(id));
        validateView[key] = ids;
      }
    };

    const setOrUnsetDateField = (key, value, tz) => {
      if (value === undefined) return;

      const raw = cleanAny(value);
      if (!raw) {
        update.$unset[key] = 1;
        validateView[key] = undefined;
        return;
      }

      const parsed = toUtcDateFromAny(raw, tz);
      if (!parsed) throw new Error(`Invalid ${key}`);

      update.$set[key] = parsed;
      validateView[key] = parsed;
    };

    // campaignTitle
    if (req.body.campaignTitle !== undefined) {
      const s = cleanAny(req.body.campaignTitle);
      if (!s) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "campaignTitle",
          requestId
        );
      }
      update.$set.campaignTitle = s;
      validateView.campaignTitle = s;
    }

    // optional strings
    setOrUnsetString("description", req.body.description);
    setOrUnsetString("campaignType", req.body.campaignType);
    setOrUnsetString("additionalNotes", req.body.additionalNotes);

    // product images
    if (req.body.productImages !== undefined) {
      const imgs = await normalizeAndUploadProductImages(req.body.productImages);

      if (!imgs.length) {
        update.$unset.productImages = 1;
        validateView.productImages = [];
      } else {
        update.$set.productImages = imgs;
        validateView.productImages = imgs;
      }
    }

    // productLink
    if (req.body.productLink !== undefined) {
      const link = cleanAny(req.body.productLink);
      if (link && !isValidHttpUrl(link)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "productLink",
          requestId,
          "productLink must be a valid http/https URL"
        );
      }
      if (!link) {
        update.$unset.productLink = 1;
        validateView.productLink = undefined;
      } else {
        update.$set.productLink = link;
        validateView.productLink = link;
      }
    }

    // videoLink
    if (req.body.videoLink !== undefined) {
      const link = cleanAny(req.body.videoLink);
      if (link && !isValidHttpUrl(link)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "videoLink",
          requestId,
          "videoLink must be a valid http/https URL"
        );
      }
      if (!link) {
        update.$unset.videoLink = 1;
        validateView.videoLink = undefined;
      } else {
        update.$set.videoLink = link;
        validateView.videoLink = link;
      }
    }

    // categoryId
    if (req.body.categoryId !== undefined) {
      const s = cleanAny(req.body.categoryId);

      if (!s) {
        update.$unset.categoryId = 1;
        update.$unset.subcategoryIds = 1;
        update.$unset.campaignCategory = 1;
        update.$unset.campaignSubcategory = 1;
        update.$unset.categories = 1;

        validateView.categoryId = undefined;
        validateView.subcategoryIds = [];
      } else {
        if (!isOid(s)) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "categoryId",
            requestId,
            "Invalid categoryId"
          );
        }

        update.$set.categoryId = toObjectId(s);   // DB value
        validateView.categoryId = s;              // validation value
      }
    }

    // subcategoryIds
    if (req.body.subcategoryIds !== undefined) {
      const ids = normalizeObjectIdArray(req.body.subcategoryIds);

      if (!ids.length) {
        update.$unset.subcategoryIds = 1;
        update.$unset.campaignSubcategory = 1;
        update.$unset.categories = 1;
        validateView.subcategoryIds = [];
      } else {
        update.$set.subcategoryIds = ids.map((id) => toObjectId(id)); // DB value
        validateView.subcategoryIds = ids;                            // validation value
      }
    }

    // object-id arrays
    setOrUnsetIdArray("campaignGoals", req.body.campaignGoals);
    setOrUnsetIdArray("influencerTierIds", req.body.influencerTierIds);
    setOrUnsetIdArray("contentFormats", req.body.contentFormats);
    setOrUnsetIdArray("contentLanguageIds", req.body.contentLanguageIds);
    setOrUnsetIdArray("targetCountryIds", req.body.targetCountryIds);
    setOrUnsetIdArray("targetAgeRanges", req.body.targetAgeRanges);
    setOrUnsetIdArray("preferredHashtags", req.body.preferredHashtags);

    // platformSelection
    if (req.body.platformSelection !== undefined) {
      const ps = toPlatformArray(req.body.platformSelection);
      if (!ps.length) {
        update.$unset.platformSelection = 1;
        validateView.platformSelection = [];
      } else {
        update.$set.platformSelection = ps;
        validateView.platformSelection = ps;
      }
    }

    // paymentType
    if (req.body.paymentType !== undefined) {
      const p = cleanAny(req.body.paymentType);
      if (!p) {
        update.$unset.paymentType = 1;
        validateView.paymentType = undefined;
      } else {
        const normalized = normalizePaymentType(p);
        update.$set.paymentType = normalized;
        validateView.paymentType = normalized;
      }
    }

    // campaignBudget / budget
    if (req.body.campaignBudget !== undefined) {
      const raw = cleanAny(req.body.campaignBudget);

      if (!raw) {
        update.$unset.campaignBudget = 1;
        update.$unset.budget = 1;
        validateView.campaignBudget = undefined;
      } else {
        const n = Number(raw);

        if (!Number.isFinite(n) || n < 0) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "campaignBudget",
            requestId,
            "campaignBudget must be >= 0"
          );
        }

        update.$set.campaignBudget = n;
        update.$set.budget = n;
        validateView.campaignBudget = n;
      }
    }

    // influencerBudget
    if (req.body.influencerBudget !== undefined) {
      const raw = cleanAny(req.body.influencerBudget);

      if (!raw) {
        update.$unset.influencerBudget = 1;
        validateView.influencerBudget = undefined;
      } else {
        const n = Number(raw);

        if (!Number.isFinite(n) || n < 0) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "influencerBudget",
            requestId,
            "influencerBudget must be >= 0"
          );
        }

        update.$set.influencerBudget = n;
        validateView.influencerBudget = n;
      }
    }

    // numeric fields
    const numericFields = ["numberOfInfluencers", "minFollowers", "maxFollowers"];
    for (const field of numericFields) {
      if (req.body[field] === undefined) continue;

      const raw = cleanAny(req.body[field]);

      if (!raw) {
        update.$unset[field] = 1;
        validateView[field] = undefined;
        continue;
      }

      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          field,
          requestId,
          `${field} must be a valid non-negative number`
        );
      }

      update.$set[field] = Math.trunc(n);
      validateView[field] = Math.trunc(n);
    }

    // dates
    try {
      setOrUnsetDateField("startAt", req.body.startAt, campaignTz);
      setOrUnsetDateField("endAt", req.body.endAt, campaignTz);

      if (req.body.campaignTimezone !== undefined) {
        update.$set.campaignTimezone = campaignTz;
        validateView.campaignTimezone = campaignTz;
      }
    } catch (e) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        e.message || "Invalid date",
        requestId
      );
    }

    // keep category display fields in sync
    const mergedCategoryId =
      validateView.categoryId !== undefined
        ? String(validateView.categoryId)
        : update.$unset.categoryId
          ? ""
          : existing.categoryId
            ? String(existing.categoryId)
            : "";

    const mergedSubIds =
      validateView.subcategoryIds !== undefined
        ? validateView.subcategoryIds.map((x) => String(x))
        : update.$unset.subcategoryIds
          ? []
          : Array.isArray(existing.subcategoryIds)
            ? existing.subcategoryIds.map((x) => String(x))
            : [];

    if (mergedCategoryId && mergedSubIds.length) {
      const rel = await resolveCategoryAndSubcategories(mergedCategoryId, mergedSubIds);

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

      update.$set.campaignCategory = rel?.cat?.name || "";
      update.$set.campaignSubcategory = Array.isArray(rel?.subs)
        ? rel.subs.map((s) => String(s.name || "")).join(", ")
        : "";

      update.$set.categories = Array.isArray(rel?.subs)
        ? rel.subs.map((sub, idx) => ({
          categoryId: mergedCategoryId,
          categoryName: rel?.cat?.name || "",
          subcategoryId: String(mergedSubIds[idx] || ""),
          subcategoryName: String(sub.name || ""),
        }))
        : [];
    } else if (update.$unset.categoryId || update.$unset.subcategoryIds) {
      update.$unset.campaignCategory = 1;
      update.$unset.campaignSubcategory = 1;
      update.$unset.categories = 1;
    }

    // timeline sync
    const mergedStartAt =
      update.$set.startAt !== undefined
        ? update.$set.startAt
        : update.$unset.startAt
          ? null
          : existing.startAt || null;

    const mergedEndAt =
      update.$set.endAt !== undefined
        ? update.$set.endAt
        : update.$unset.endAt
          ? null
          : existing.endAt || null;

    if (mergedStartAt && mergedEndAt) {
      update.$set.timeline = {
        startDate: mergedStartAt,
        endDate: mergedEndAt,
      };
    } else if (update.$unset.startAt || update.$unset.endAt) {
      update.$unset.timeline = 1;
    }

    const hasSetBeforeStatus = Object.keys(update.$set).length > 0;
    const hasUnsetBeforeStatus = Object.keys(update.$unset).length > 0;

    const requestedStatus = req.body.status ? pickStatus(req.body.status) : "draft";

    if (requestedStatus === "active") {
      const merged = {
        ...existing.toObject(),
        ...validateView, // <-- use plain/string values for validator
        productImages:
          validateView.productImages !== undefined
            ? validateView.productImages
            : existing.productImages || [],
        categoryId:
          validateView.categoryId !== undefined
            ? validateView.categoryId
            : existing.categoryId
              ? String(existing.categoryId)
              : undefined,
        subcategoryIds:
          validateView.subcategoryIds !== undefined
            ? validateView.subcategoryIds
            : Array.isArray(existing.subcategoryIds)
              ? existing.subcategoryIds.map((x) => String(x))
              : [],
        status: "active",
        brandId,
      };

      const v = await validateForMode(res, requestId, "publish", merged, {
        existingProductImages: merged.productImages || [],
      });
      if (!v.ok) return v.resp;

      const win = parseCampaignWindow(
        {
          ...existing.toObject(),
          ...update.$set,
          ...validateView,
          status: "active",
          brandId,
        },
        campaignTz,
        requestId,
        res,
        true
      );

      if (!win.ok) return win.resp;

      update.$set.status = "active";
      update.$set.startAt = win.value.startAt;
      update.$set.endAt = win.value.endAt;
      update.$set.timeline = {
        startDate: win.value.startAt,
        endDate: win.value.endAt,
      };
      update.$set.publishedAt = existing.publishedAt || new Date();
      update.$set.publishStatus = "published";
      update.$set.isDraft = 0;
      update.$set.isActive = 1;
      update.$set.statusUpdatedAt = new Date();
      update.$set.campaignTimezone = campaignTz;
      update.$set.createdLocation = {
        ip: geo?.ip,
        timezone: geo?.timezone,
        country: geo?.country,
        state: geo?.state,
        city: geo?.city,
        latitude: typeof geo?.latitude === "number" ? geo.latitude : undefined,
        longitude: typeof geo?.longitude === "number" ? geo.longitude : undefined,
        source: geo?.source,
      };
    } else {
      update.$set.status = "draft";
      update.$set.publishStatus = "draft";
      update.$set.isDraft = 1;
      update.$set.isActive = 0;
      update.$set.statusUpdatedAt = new Date();
      update.$unset.publishedAt = 1;
    }

    if (!hasSetBeforeStatus && !hasUnsetBeforeStatus && !req.body.status) {
      const enriched = (await enrichCampaigns([existing]))[0];
      return ApiResponse.sendOk(res, HttpStatus.OK, { doc: enriched }, requestId);
    }

    if (Object.keys(update.$set).length === 0) delete update.$set;
    if (Object.keys(update.$unset).length === 0) delete update.$unset;

    const updated = await Campaign.findOneAndUpdate(
      {
        _id: toObjectId(campaignId),
        brandId: toObjectId(brandId),
        status: "draft",
        isDraft: 1,
      },
      update,
      { new: true }
    );

    if (!updated) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Draft campaign not found after update",
        requestId
      );
    }

    const enriched = (await enrichCampaigns([updated]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message:
          requestedStatus === "active"
            ? "Draft campaign published successfully."
            : "Draft campaign updated successfully.",
        doc: enriched,
      },
      requestId
    );
  } catch (err) {
    return sendControllerError(res, requestId, err);
  }
};
exports.getDraftCampaigns = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    if (!brandId || !isOid(brandId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 10, 1, 100);
    const skip = (page - 1) * limit;

    const normalizeDateField = (value) => {
      const raw = clean(value);
      const allowed = ["createdAt", "updatedAt", "startAt", "endAt", "publishedAt"];
      return allowed.includes(raw) ? raw : "updatedAt";
    };

    const normalizeDatePreset = (value) => {
      const raw = clean(value).toLowerCase();
      const map = {
        today: "today",
        last7days: "last7days",
        last_7_days: "last7days",
        last30days: "last30days",
        last_30_days: "last30days",
        thisweek: "thisweek",
        this_week: "thisweek",
        thismonth: "thismonth",
        this_month: "thismonth",
      };
      return map[raw] || "";
    };

    const parseClientDateToUtc = (raw, timezone, boundary = "start") => {
      const s = clean(raw);
      if (!s) return null;

      const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
      const m = s.match(ddmmyyyy);
      if (m) {
        const [, dd, mm, yyyy] = m;
        const dt = DateTime.fromObject(
          {
            year: Number(yyyy),
            month: Number(mm),
            day: Number(dd),
            hour: boundary === "end" ? 23 : 0,
            minute: boundary === "end" ? 59 : 0,
            second: boundary === "end" ? 59 : 0,
            millisecond: boundary === "end" ? 999 : 0,
          },
          { zone: timezone }
        );
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (isoDate.test(s)) {
        const dt = DateTime.fromISO(s, { zone: timezone }).set({
          hour: boundary === "end" ? 23 : 0,
          minute: boundary === "end" ? 59 : 0,
          second: boundary === "end" ? 59 : 0,
          millisecond: boundary === "end" ? 999 : 0,
        });
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      const abs = toUtcFromLocalOrAbsolute(s, timezone);
      return abs || null;
    };

    const buildUtcRangeFromPreset = (preset, timezone) => {
      const now = DateTime.now().setZone(timezone);

      if (preset === "today") {
        return {
          from: now.startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "last7days") {
        return {
          from: now.minus({ days: 6 }).startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "last30days") {
        return {
          from: now.minus({ days: 29 }).startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "thisweek") {
        return {
          from: now.startOf("week").toUTC().toJSDate(),
          to: now.endOf("week").toUTC().toJSDate(),
        };
      }

      if (preset === "thismonth") {
        return {
          from: now.startOf("month").toUTC().toJSDate(),
          to: now.endOf("month").toUTC().toJSDate(),
        };
      }

      return null;
    };

    const buildSortLocal = (sortByRaw, sortOrderRaw, fallback = { updatedAt: -1 }) => {
      const allowed = [
        "createdAt",
        "updatedAt",
        "startAt",
        "endAt",
        "publishedAt",
        "campaignTitle",
        "campaignBudget",
        "numberOfInfluencers",
        "status",
      ];

      const sortBy = clean(sortByRaw);
      const sortOrder = String(sortOrderRaw || "desc").toLowerCase() === "asc" ? 1 : -1;

      if (!allowed.includes(sortBy)) return fallback;
      return { [sortBy]: sortOrder };
    };

    const tz = getCampaignTimezone(req.body);

    // ---------------- Build filter ----------------
    const filter = {
      brandId: toObjectId(brandId),
      status: "draft",
      isDraft: 1,
    };

    // search
    const search = clean(req.body.search);
    if (search) {
      filter.$or = buildSearchOr(search);
    }

    // byAi
    if (req.body.byAi === 0 || req.body.byAi === 1 || req.body.byAi === "0" || req.body.byAi === "1") {
      filter.byAi = Number(req.body.byAi);
    }

    // campaignType
    if (clean(req.body.campaignType)) {
      filter.campaignType = {
        $regex: new RegExp(escapeRegex(clean(req.body.campaignType)), "i"),
      };
    }

    // categoryIds / categoryId
    const catIds = normalizeObjectIdArray(req.body.categoryIds ?? req.body.categoryId);
    if (catIds.length) {
      filter.categoryId = { $in: catIds.map((id) => toObjectId(id)) };
    }

    // subcategoryIds / subcategoryId
    const subIds = normalizeObjectIdArray(req.body.subcategoryIds ?? req.body.subcategoryId);
    if (subIds.length) {
      filter.subcategoryIds = { $in: subIds.map((id) => toObjectId(id)) };
    }

    // date filters
    const dateField = normalizeDateField(req.body.dateField);
    const preset = normalizeDatePreset(req.body.datePreset);

    if (preset) {
      const range = buildUtcRangeFromPreset(preset, tz);
      if (range) {
        filter[dateField] = { $gte: range.from, $lte: range.to };
      }
    } else {
      const hasFrom = !!clean(req.body.dateFrom);
      const hasTo = !!clean(req.body.dateTo);

      const fromUtc = hasFrom ? parseClientDateToUtc(req.body.dateFrom, tz, "start") : null;
      const toUtc = hasTo ? parseClientDateToUtc(req.body.dateTo, tz, "end") : null;

      if (hasFrom && !fromUtc) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "dateFrom",
          requestId,
          "Invalid dateFrom. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (hasTo && !toUtc) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "dateTo",
          requestId,
          "Invalid dateTo. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (fromUtc || toUtc) {
        if (fromUtc && toUtc && fromUtc.getTime() > toUtc.getTime()) {
          return fail(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "dateFrom must be <= dateTo",
            requestId
          );
        }

        filter[dateField] = {};
        if (fromUtc) filter[dateField].$gte = fromUtc;
        if (toUtc) filter[dateField].$lte = toUtc;
      }
    }

    const sort = buildSortLocal(req.body.sortBy, req.body.sortOrder, { updatedAt: -1 });

    const [items, total] = await Promise.all([
      Campaign.find(filter).sort(sort).skip(skip).limit(limit),
      Campaign.countDocuments(filter),
    ]);

    const enrichedItems = await enrichCampaigns(items);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        items: enrichedItems,
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

exports.rejectedCampaign = async (req, res) => {
  try {
    const { influencerId } = req.params;

    if (!influencerId) {
      return res.status(400).json({
        success: false,
        message: "influencerId is required",
      });
    }

    const rejectedCampaigns = await Contract.aggregate([
      {
        $match: {
          influencerId: influencerId,
          status: "REJECTED",
        },
      },
      {
        $project: {
          _id: 1,
          campaignId: 1,
          status: 1,
        },
      },
      {
        $addFields: {
          campaignObjectId: { $toObjectId: "$campaignId" },
        },
      },
      {
        $lookup: {
          from: "campaigns",
          localField: "campaignObjectId",
          foreignField: "_id",
          as: "campaignData",
        },
      },
      {
        $unwind: {
          path: "$campaignData",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          campaignId: 1,
          status: 1,
          campaignData: 1,
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      count: rejectedCampaigns.length,
      data: rejectedCampaigns,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};