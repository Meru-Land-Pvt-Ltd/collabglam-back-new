const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");

const CountryModel = require("../models/country");
const { InfluencerTierModel } = require("../models/influencerTier");
const { PreferredHashtagModel } = require("../models/preferredHashtag");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { AgeRangeModel } = require("../models/ageRange");
const { ContentFormatModel } = require("../models/contentFormat");
const ContentLanguageModel = require("../models/language");

const clean = (v) => (typeof v === "string" ? v.trim() : "");

const getRequestId = (req) =>
  req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const EC = (code) => code;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getLimit = (req, fallback = 500) => {
  const raw = clean(req.query?.limit);
  if (!raw) return fallback;

  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;

  return Math.min(500, Math.max(1, Math.floor(n)));
};

const getSearch = (req) => clean(req.query?.search);

// ---------- Countries ----------
// GET /list/countries/getall?search=ind&limit=200
exports.getAllCountries = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = {};
    if (search) {
      const s = escapeRegExp(search);
      filter.$or = [
        { countryNameEn: { $regex: s, $options: "i" } },
        { countryCode: { $regex: `^${s}`, $options: "i" } },
      ];
    }

    const countries = await CountryModel.find(filter)
      .select("_id countryNameEn flag countryCode")
      .sort({ countryNameEn: 1 })
      .limit(limit)
      .lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, countries, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Influencer Tiers ----------
exports.getAllInfluencerTiers = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const rawSearch = getSearch(req);
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
    const limit = Math.min(getLimit(req, 500), 500);

    const filter = { isActive: { $ne: false } };

    if (search) {
      const s = escapeRegExp(search);

      const or = [{ category: { $regex: s, $options: "i" } }];

      const asNumber = Number(search);
      if (!Number.isNaN(asNumber)) {
        or.push({ value: asNumber });
      }

      or.push({ value: { $regex: s, $options: "i" } });

      filter.$or = or;
    }

    const items = await InfluencerTierModel.find(filter)
      .select({ _id: 1, category: 1, value: 1, sortOrder: 1 })
      .sort({ sortOrder: 1, category: 1 })
      .limit(limit)
      .lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, items, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Preferred Hashtags ----------
// GET /list/preferred-hashtags/getall?search=travel&limit=500
exports.getAllPreferredHashtags = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = { isActive: { $ne: false } };

    if (search) {
      const s = escapeRegExp(search);
      filter.tag = { $regex: s, $options: "i" };
    }

    const items = await PreferredHashtagModel.find(filter)
      .select("_id tag sortOrder")
      .sort({ sortOrder: 1, tag: 1 })
      .limit(limit)
      .lean();

    const response = items.map(({ _id, tag }) => ({ _id, tag }));

    return ApiResponse.sendOk(res, HttpStatus.OK, response, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Product/Service Goals ----------
// GET /list/product-service-goals/getall?search=sales&limit=500
exports.getAllProductServiceGoals = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = { isActive: true };
    if (search) {
      const s = escapeRegExp(search);
      filter.goal = { $regex: s, $options: "i" };
    }

    const items = await ProductServiceGoalModel.find(filter)
      .select("_id goal sortOrder")
      .sort({ sortOrder: 1, goal: 1 })
      .limit(limit)
      .lean();

    const response = items.map(({ _id, goal }) => ({ _id, goal }));

    return ApiResponse.sendOk(res, HttpStatus.OK, response, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Age Ranges ----------
// GET /list/age-ranges/getall?search=18&limit=500
const getStart = (r) => {
  const s = clean(r);
  if (s.includes("+")) return 9999;

  const m = s.match(/^(\d+)/);
  return m ? Number(m[1]) : 9998;
};

exports.getAllAgeRanges = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = {};
    if (search) {
      const s = escapeRegExp(search);
      filter.range = { $regex: s, $options: "i" };
    }

    const items = await AgeRangeModel.find(filter)
      .select("_id range")
      .limit(limit)
      .lean();

    items.sort((a, b) => getStart(a.range) - getStart(b.range));

    return ApiResponse.sendOk(res, HttpStatus.OK, items, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Content Formats ----------
// GET /list/content-formats/getall?search=reel&limit=500
exports.getAllContentFormats = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = { isActive: true };
    if (search) {
      const s = escapeRegExp(search);
      filter.format = { $regex: s, $options: "i" };
    }

    const items = await ContentFormatModel.find(filter)
      .select("_id format")
      .sort({ sortOrder: 1, format: 1 })
      .limit(limit)
      .lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, items, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ---------- Content Languages ----------
// GET /list/content-languages/getall?search=en&limit=500
exports.getAllContentLanguages = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = getSearch(req);
    const limit = getLimit(req, 500);

    const filter = { isActive: true };
    if (search) {
      const s = escapeRegExp(search);
      filter.$or = [
        { code: { $regex: s, $options: "i" } },
        { name: { $regex: s, $options: "i" } },
      ];
    }

    const items = await ContentLanguageModel.find(filter)
      .select("_id code name")
      .sort({ name: 1 })
      .limit(limit)
      .lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, items, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};