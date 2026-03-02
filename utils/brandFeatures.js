// utils/brandFeatures.js
const Brand = require('../models/brand');

const MODASH_COSTS = {
  search_quota: 0.15,       // per search
  profile_view_quota: 1.0,  // per profile view
};

const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Get feature row by key from brand.subscription.features[] */
function getFeatureRow(sub, key) {
  return (sub?.features || []).find(f => f.key === key) || null;
}

/** 0 ⇒ unlimited */
function getLimit(row) {
  if (!row) return 0;
  const raw = row.limit ?? row.value ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** If feature has monthly window, roll/reset when expired. Returns fresh feature row. */
async function ensureMonthlyWindowBrand(brandId, key, row) {
  const isMonthly = /per\s*month/i.test(String(row?.note || '')) || row?.resetsEvery === 'monthly';
  if (!isMonthly) return row;

  const now = new Date();
  const resetsAt = row?.resetsAt ? new Date(row.resetsAt) : null;

  if (!resetsAt || now > resetsAt) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);
    await Brand.updateOne(
      { brandId, 'subscription.features.key': key },
      { $set: { 'subscription.features.$.used': 0, 'subscription.features.$.resetsAt': next } }
    );
    return { ...row, used: 0, resetsAt: next };
  }
  return row;
}

/**
 * Atomically consume N units from a feature (limit 0 = unlimited).
 * If capped and would exceed, returns { ok:false, remaining }.
 * On success returns { ok:true, remaining }.
 */
async function consumeBrandUnits(brandId, key, n = 1) {
  const brand = await Brand.findOne({ brandId }, 'subscription').lean();
  if (!brand?.subscription) return { ok: false, code: 'NO_SUB', remaining: 0 };

  let row = getFeatureRow(brand.subscription, key);
  if (!row) return { ok: false, code: 'NO_FEATURE', remaining: 0 };
  row = await ensureMonthlyWindowBrand(brandId, key, row);

  const limit = getLimit(row);
  const used  = toNum(row.used);

  if (limit > 0 && used + n > limit) {
    return { ok: false, code: 'LIMIT', remaining: Math.max(0, limit - used) };
  }

  // race-safe atomic guard when limited
  if (limit > 0) {
    const res = await Brand.updateOne(
      {
        brandId,
        'subscription.features': {
          $elemMatch: { key, used: { $lte: limit - n } }
        }
      },
      { $inc: { 'subscription.features.$[feat].used': n } },
      { arrayFilters: [{ 'feat.key': key }] }
    );
    if (res.matchedCount === 0) {
      const after = await Brand.findOne({ brandId }, 'subscription.features').lean();
      const fresh = getFeatureRow(after?.subscription, key);
      const remaining = Math.max(0, getLimit(fresh) - toNum(fresh?.used));
      return { ok: false, code: 'RACE', remaining };
    }
  } else {
    // unlimited: still track used for analytics if you want
    await Brand.updateOne(
      { brandId, 'subscription.features.key': key },
      { $inc: { 'subscription.features.$[feat].used': n } },
      { arrayFilters: [{ 'feat.key': key }] }
    );
  }

  const remaining = limit > 0 ? Math.max(0, limit - (used + n)) : 0;
  return { ok: true, remaining };
}

/** Boolean gate: treat limit>0 or value===1 as enabled; 0 as disabled. */
function isEnabled(row) {
  if (!row) return false;
  if (typeof row.value === 'string') return !!row.value; // e.g., advanced_filters = 'mvp'
  const lim = getLimit(row);
  return lim === 0 ? true : lim > 0; // unlimited or >0
}

/** Ensure a boolean feature is enabled; else throw-like object for controller */
async function requireBrandFeature(brandId, key, message = 'Not allowed on your plan') {
  const brand = await Brand.findOne({ brandId }, 'subscription').lean();
  if (!brand?.subscription) return { ok: false, code: 'NO_SUB', message };

  const row = getFeatureRow(brand.subscription, key);
  if (!row || !isEnabled(row)) return { ok: false, code: 'DISABLED', message };
  return { ok: true };
}

/** Read advanced_filters level: 'none' | 'mvp' | 'full' (string value) */
async function readAdvancedFiltersLevel(brandId) {
  const brand = await Brand.findOne({ brandId }, 'subscription.features').lean();
  const row = getFeatureRow(brand?.subscription, 'advanced_filters');
  return row?.value || 'none';
}

/** Track internal Modash credits monthly */
async function chargeModashCredits(brandId, featureKey, units = 1) {
  const perUnit = MODASH_COSTS[featureKey] || 0;
  if (perUnit === 0) return;

  // store under subscription.internalCredits { used, resetsAt } (monthly)
  const brand = await Brand.findOne({ brandId }, 'subscription.internalCredits').lean();
  let used = toNum(brand?.subscription?.internalCredits?.used);
  let resetsAt = brand?.subscription?.internalCredits?.resetsAt ? new Date(brand.subscription.internalCredits.resetsAt) : null;

  const now = new Date();
  if (!resetsAt || now > resetsAt) {
    const next = new Date(now); next.setUTCMonth(next.getUTCMonth() + 1);
    await Brand.updateOne(
      { brandId },
      { $set: { 'subscription.internalCredits.used': 0, 'subscription.internalCredits.resetsAt': next } }
    );
    used = 0; resetsAt = next;
  }

  const delta = units * perUnit;
  await Brand.updateOne(
    { brandId },
    { $inc: { 'subscription.internalCredits.used': delta } }
  );
}

/** Convenience: consume+charge in one go for quota features that cost Modash credits */
async function consumeWithCredits(brandId, featureKey, units = 1) {
  const take = await consumeBrandUnits(brandId, featureKey, units);
  if (!take.ok) return take;
  await chargeModashCredits(brandId, featureKey, units);
  return take;
}

module.exports = {
  consumeBrandUnits,
  consumeWithCredits,
  ensureMonthlyWindowBrand,
  requireBrandFeature,
  readAdvancedFiltersLevel,
};
