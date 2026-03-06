const OpenAI = require("openai");
const { DateTime } = require("luxon");
const { Types } = require("mongoose");

const { ApiResponse } = require("../core/http/ApiResponse.js");
const { HttpStatus } = require("../core/http/HttpStatus.js");

const { CampaignModel } = require("../models/campaign.js");
const { CategoryModel } = require("../models/categories.js");
const { CountryModel } = require("../models/country.js");
const { AgeRangeModel } = require("../models/ageRange.js");
const { ContentLanguageModel } = require("../models/language.js");
const { InfluencerTierModel } = require("../models/influencerTier.js");
const { ProductServiceGoalModel } = require("../models/productServiceGoal.js");
const { ContentFormatModel } = require("../models/contentFormat.js");
const { PreferredHashtagModel } = require("../models/preferredHashtag.js");

const { detectGeoFromRequest } = require("../utils/ipGeo.js");

// ---------------- Helpers ----------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const EC = (code) => code;
const getRequestId = (req) => req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const isOid = (v) => Types.ObjectId.isValid(clean(v));
const toObjectId = (id) => new Types.ObjectId(clean(id));
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
  if (Array.isArray(v)) return v.map((x) => clean(String(x))).filter((id) => Types.ObjectId.isValid(id));
  const s = clean(v);
  return s && Types.ObjectId.isValid(s) ? [s] : [];
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
  if (!Types.ObjectId.isValid(s)) {
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

// ---------------- Status + Platforms ----------------
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

// ---------------- Category/Subcategory ----------------
const resolveCategoryAndSubcategories = async (categoryId, subIds) => {
  const cat = await CategoryModel.findById(categoryId).select("_id name subcategories").lean();
  if (!cat) return { cat: null, subs: [], error: "Category not found" };

  const allSubs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
  const subMap = new Map(allSubs.map((s) => [String(s._id), s]));

  const orderedSubs = subIds.map((id) => subMap.get(String(id))).filter(Boolean);
  if (subIds.length && orderedSubs.length !== subIds.length) {
    return { cat: null, subs: [], error: "One or more subcategories not found in this category" };
  }

  return { cat, subs: orderedSubs, error: "" };
};

// ---------------- Time ----------------
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

// ---------------- Enrichment ----------------
const oidToStr = (v) => (v ? String(v) : "");
const asIdArray = (v) =>
  Array.isArray(v) ? v.map((x) => oidToStr(x)).filter((x) => Types.ObjectId.isValid(x)) : [];

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
    if (Types.ObjectId.isValid(cid)) categoryIds.add(cid);

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
      ? InfluencerTierModel.find({ _id: { $in: [...tierIds].map((id) => toObjectId(id)) } })
          .select("_id category value sortOrder")
          .lean()
      : Promise.resolve([]),

    formatIds.size
      ? ContentFormatModel.find({ _id: { $in: [...formatIds].map((id) => toObjectId(id)) } }).lean()
      : Promise.resolve([]),

    langIds.size
      ? ContentLanguageModel.find({ _id: { $in: [...langIds].map((id) => toObjectId(id)) } })
          .select("_id code name isActive")
          .lean()
      : Promise.resolve([]),

    countryIds.size
      ? CountryModel.find({ _id: { $in: [...countryIds].map((id) => toObjectId(id)) } })
          .select("_id countryNameEn countryNameLocal countryCode currencyCode currencyNameEn region flag")
          .lean()
      : Promise.resolve([]),

    ageIds.size
      ? AgeRangeModel.find({ _id: { $in: [...ageIds].map((id) => toObjectId(id)) } }).select("_id range").lean()
      : Promise.resolve([]),

    prefHashtagIds.size
      ? PreferredHashtagModel.find({ _id: { $in: [...prefHashtagIds].map((id) => toObjectId(id)) } }).lean()
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
    const cat = Types.ObjectId.isValid(categoryId) ? catMap.get(categoryId) : null;

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

// ---------------- Validation + Timing ----------------
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

  if (!startAtUtc) return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId) };
  if (!endAtUtc) return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId) };

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

const inferMode = (statusRaw, scheduledAt) => {
  if (clean(scheduledAt)) return "schedule";
  const statusStr = clean(statusRaw);
  if (!statusStr) return "publish";

  const status = pickStatus(statusRaw);
  if (status === "draft") return "draft";
  if (status === "scheduled") return "schedule";
  return "publish";
};

const validateForMode = async (res, requestId, mode, body) => {
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

  const imgsR = requireArray(res, requestId, "productImages", body.productImages);
  if (!imgsR.ok) return { ok: false, resp: imgsR.resp };

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

const buildCampaignDoc = (body, geo, status, byAi, timing) => {
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

  const base = {
    brandId: toObjectId(body.brandId),
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

    campaignBudget: Number.isFinite(toNumber(body.campaignBudget)) ? toNumber(body.campaignBudget) : undefined,
    numberOfInfluencers: Number.isFinite(toInt(body.numberOfInfluencers)) ? toInt(body.numberOfInfluencers) : undefined,
    minFollowers: Number.isFinite(toInt(body.minFollowers)) ? toInt(body.minFollowers) : undefined,
    maxFollowers: Number.isFinite(toInt(body.maxFollowers)) ? toInt(body.maxFollowers) : undefined,

    additionalNotes: isDraft ? strOrUndef(body.additionalNotes) : clean(body.additionalNotes) || "",
  };

  if (timing?.startAt) base.startAt = timing.startAt;
  if (timing?.endAt) base.endAt = timing.endAt;

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

// ---------------- AI prompt ----------------
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

// =======================================================
// POST: Create Campaign
// =======================================================
exports.createCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const geo = await detectGeoFromRequest(req);
    const campaignTz = getCampaignTimezone(req.body);

    const mode = inferMode(req.body.status, req.body.scheduledAt);
    const v = await validateForMode(res, requestId, mode, req.body);
    if (!v.ok) return v.resp;

    const status = mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "active";

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

    const docToCreate = buildCampaignDoc(req.body, geo, status, 0, timing);
    const created = await CampaignModel.create(docToCreate);

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

// =======================================================
// POST: AI Prefill
// =======================================================
exports.prefillCampaignWithAI = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const geo = await detectGeoFromRequest(req);
    const tz = getCampaignTimezone(req.body);
    const nowLocal = DateTime.now().setZone(tz);

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
      InfluencerTierModel.find({}).select("_id category value sortOrder").lean().limit(120),
      ContentFormatModel.find({}).select("_id name title type format").lean().limit(200),
      ContentLanguageModel.find({ isActive: true }).select("_id code name").lean().limit(200),
    ]);

    const prefHashtagsDocs = await PreferredHashtagModel.find({
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
          "Pick formats/goals/tier based on description + category/subcategory.",
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

    const clampInt = (v, def, min, max) => {
      const n = toInt(v);
      if (!Number.isFinite(n)) return def;
      return Math.max(min, Math.min(max, n));
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
        win.value
      );
      const savedDoc = await CampaignModel.create(docToCreate);
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