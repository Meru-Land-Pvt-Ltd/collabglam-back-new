// utils/quota.js
const Brand = require("../models/brand");
const getFeature = require("./getFeature"); // adjust path if needed

function readLimit(featureRow) {
  if (!featureRow) return 0;

  // subscription snapshot uses { key, limit, used }
  // but we also fallback if you ever pass raw plan features
  const raw = featureRow.limit ?? featureRow.value ?? 0;

  // object-based unlimited (if ever stored)
  if (raw && typeof raw === "object" && raw.unlimited === true) return -1;

  const num = Number(raw);
  // non-numeric -> treat as unlimited
  return Number.isFinite(num) ? num : 0;
}

async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) throw new Error("brandId is required for quota checks");
  if (!featureKey) throw new Error("featureKey is required for quota checks");

  // Only fetch subscription; keep it light
  const brand = await Brand.findOne({ brandId }, "subscription").lean();
  if (!brand?.subscription) {
    throw new Error("Brand subscription not configured");
  }

  const feature = getFeature.getFeature(brand.subscription, featureKey);

  // Missing feature row => treat as unlimited and do not increment (no row to update)
  if (!feature) {
    return { limit: 0, used: 0, remaining: Infinity };
  }

  const limit = readLimit(feature);
  const used = Number(feature.used || 0) || 0;

  // Unlimited if limit <= 0 (supports 0 or -1)
  if (limit <= 0) {
    // We can still track usage if the feature row exists
    await Brand.updateOne(
      { brandId, "subscription.features.key": featureKey },
      { $inc: { "subscription.features.$.used": amount } }
    );

    return { limit, used: used + amount, remaining: Infinity };
  }

  // Enforce quota for positive limits
  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = "QUOTA_EXCEEDED";
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }

  await Brand.updateOne(
    { brandId, "subscription.features.key": featureKey },
    { $inc: { "subscription.features.$.used": amount } }
  );

  return {
    limit,
    used: used + amount,
    remaining: limit - (used + amount),
  };
}

module.exports = {
  ensureBrandQuota,
  readLimit,
};
