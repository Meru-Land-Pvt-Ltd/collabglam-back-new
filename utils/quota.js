const mongoose = require("mongoose");
const Brand = require("../models/brand");
const featureUtils = require("./getFeature");

const getFeature =
  typeof featureUtils === "function"
    ? featureUtils
    : featureUtils?.getFeature;

if (typeof getFeature !== "function") {
  throw new Error("getFeature helper is not exported correctly");
}

const FEATURE_KEY_ALIASES = {
  searches_per_month: "influencer_search_per_month",
  profile_views_per_month: "influencer_profile_views_per_month",
};

function normalizeFeatureKey(featureKey) {
  const clean = String(featureKey || "").trim();
  return FEATURE_KEY_ALIASES[clean] || clean;
}

function normalizeBrandId(brandId) {
  return String(brandId || "").trim();
}

function buildBrandLookupQuery(brandId) {
  const cleanBrandId = normalizeBrandId(brandId);

  const or = [{ brandId: cleanBrandId }];

  if (mongoose.Types.ObjectId.isValid(cleanBrandId)) {
    or.push({ _id: new mongoose.Types.ObjectId(cleanBrandId) });
  }

  return { $or: or };
}

function pickSubscriptionSnapshot(brandDoc) {
  if (!brandDoc) return null;

  return (
    brandDoc.subscription ||
    brandDoc.subscriptionSnapshot ||
    brandDoc.currentSubscription ||
    brandDoc.planSnapshot ||
    null
  );
}

function readLimit(featureRow) {
  if (!featureRow) return 0;

  const raw = featureRow.limit ?? featureRow.value ?? 0;

  if (raw && typeof raw === "object" && raw.unlimited === true) {
    return -1;
  }

  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  const cleanBrandId = normalizeBrandId(brandId);
  const normalizedFeatureKey = normalizeFeatureKey(featureKey);
  const incrementBy = Number(amount);

  if (!cleanBrandId) {
    throw new Error("brandId is required for quota checks");
  }

  if (!normalizedFeatureKey) {
    throw new Error("featureKey is required for quota checks");
  }

  if (!Number.isFinite(incrementBy) || incrementBy <= 0) {
    throw new Error("amount must be a positive number");
  }

  const brandQuery = buildBrandLookupQuery(cleanBrandId);

  const brand = await Brand.findOne(
    brandQuery,
    "brandId subscription subscriptionSnapshot currentSubscription planSnapshot"
  ).lean();

  if (!brand) {
    throw new Error(`Brand not found for identifier: ${cleanBrandId}`);
  }

  const subscription = pickSubscriptionSnapshot(brand);

  if (!subscription) {
    throw new Error(
      `Brand subscription not configured for identifier: ${cleanBrandId}`
    );
  }

  const feature = getFeature(subscription, normalizedFeatureKey);

  // Missing feature row = treat as unlimited, do not increment because no row exists
  if (!feature) {
    return { limit: 0, used: 0, remaining: Infinity };
  }

  const limit = readLimit(feature);
  const used = Number(feature.used || 0) || 0;

  const updateQuery = {
    ...brandQuery,
    "subscription.features.key": normalizedFeatureKey,
  };

  // Unlimited if limit <= 0
  if (limit <= 0) {
    await Brand.updateOne(updateQuery, {
      $inc: { "subscription.features.$.used": incrementBy },
    });

    return {
      limit,
      used: used + incrementBy,
      remaining: Infinity,
    };
  }

  // Enforce quota for positive limits
  if (used + incrementBy > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(
      `Quota exceeded for feature ${normalizedFeatureKey}`
    );
    err.code = "QUOTA_EXCEEDED";
    err.meta = {
      limit,
      used,
      requested: incrementBy,
      remaining,
      featureKey: normalizedFeatureKey,
    };
    throw err;
  }

  await Brand.updateOne(updateQuery, {
    $inc: { "subscription.features.$.used": incrementBy },
  });

  return {
    limit,
    used: used + incrementBy,
    remaining: limit - (used + incrementBy),
  };
}

module.exports = {
  ensureBrandQuota,
  readLimit,
  normalizeFeatureKey,
};