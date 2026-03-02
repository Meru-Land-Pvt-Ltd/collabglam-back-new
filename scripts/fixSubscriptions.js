/* scripts/fixSubscriptions.js
 * Sync subscription.features for all existing Influencers & Brands
 * so they match their SubscriptionPlan.features
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Influencer = require('../models/influencer');
const Brand = require('../models/brand');
const SubscriptionPlan = require('../models/subscription');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Please define it in .env');
  process.exit(1);
}

// Helper: build subscription.features from plan.features, preserving used counts
function buildFeaturesFromPlan(plan, currentFeatures = []) {
  const planFeatures = Array.isArray(plan.features) ? plan.features : [];
  if (!planFeatures.length) return [];

  const usedByKey = new Map();
  if (Array.isArray(currentFeatures)) {
    for (const f of currentFeatures) {
      if (!f || !f.key) continue;
      const used = typeof f.used === 'number' ? f.used : 0;
      usedByKey.set(String(f.key), used);
    }
  }

  const newFeatures = planFeatures.map((f) => {
    const key = String(f.key);
    return {
      key,
      limit: typeof f.value === 'number' ? f.value : 0,
      used: usedByKey.has(key) ? usedByKey.get(key) : 0
    };
  });

  return newFeatures;
}

async function fixModel(Model, roleName) {
  console.log(`\n🔍 Processing ${roleName} subscriptions...`);

  let processed = 0;
  let updated = 0;
  let skippedNoPlan = 0;
  let skippedNoFeatures = 0;

  // Stream through docs to avoid loading everything into memory
  const cursor = Model.find(
    { 'subscription.planId': { $exists: true, $ne: null } },
    'subscription'
  ).cursor();

  for await (const doc of cursor) {
    processed += 1;

    const sub = doc.subscription || {};
    const planId = sub.planId;
    const planName = sub.planName;

    if (!planId && !planName) {
      continue;
    }

    // 1) Try to find by planId
    let plan = null;
    if (planId) {
      plan = await SubscriptionPlan.findOne({ planId }).lean();
    }

    // 2) Fallback: role + slug name
    if (!plan && planName) {
      plan = await SubscriptionPlan.findOne({
        role: roleName,
        name: planName
      }).lean();
    }

    if (!plan) {
      skippedNoPlan += 1;
      continue;
    }

    const newFeatures = buildFeaturesFromPlan(plan, sub.features);
    if (!newFeatures.length) {
      skippedNoFeatures += 1;
      continue;
    }

    // Optional: avoid unnecessary writes if features already identical
    const current = Array.isArray(sub.features) ? sub.features : [];
    const currentJson = JSON.stringify(
      current.map(f => ({ key: f.key, limit: f.limit, used: f.used }))
    );
    const nextJson = JSON.stringify(
      newFeatures.map(f => ({ key: f.key, limit: f.limit, used: f.used }))
    );

    if (currentJson === nextJson) {
      continue; // already in sync
    }

    // Update subscription features
    sub.features = newFeatures;
    doc.subscription = sub;

    await doc.save();
    updated += 1;
  }

  console.log(`✅ ${roleName} done.`);
  console.log(`   Processed:        ${processed}`);
  console.log(`   Updated:          ${updated}`);
  console.log(`   No matching plan: ${skippedNoPlan}`);
  console.log(`   Plan w/o features:${skippedNoFeatures}`);
}

async function main() {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    await fixModel(Influencer, 'Influencer');
    await fixModel(Brand, 'Brand');

    console.log('\n🎉 Migration complete.');
  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
