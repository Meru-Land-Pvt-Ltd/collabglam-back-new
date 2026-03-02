// scripts/getFreePlanIds.js
require("dotenv").config();
const mongoose = require("mongoose");
const SubscriptionPlan = require("../models/subscription");

async function run() {
  const { MONGODB_URI } = process.env;
  if (!MONGODB_URI) {
    console.error("❌ Set MONGODB_URI in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✅ MongoDB connected");

  const brandFree = await SubscriptionPlan.findOne({ role: "Brand", name: "free" })
    .select("planId role name displayName monthlyCost currency sortOrder")
    .lean();

  const influencerFree = await SubscriptionPlan.findOne({ role: "Influencer", name: "free" })
    .select("planId role name displayName monthlyCost currency sortOrder")
    .lean();

  if (!brandFree) console.log("⚠️ Brand FREE plan not found");
  if (!influencerFree) console.log("⚠️ Influencer FREE plan not found");

  console.log("\n=== FREE PLAN IDs ===");
  console.log(
    JSON.stringify(
      {
        Brand: brandFree
          ? { planId: brandFree.planId, monthlyCost: brandFree.monthlyCost, currency: brandFree.currency }
          : null,
        Influencer: influencerFree
          ? { planId: influencerFree.planId, monthlyCost: influencerFree.monthlyCost, currency: influencerFree.currency }
          : null,
      },
      null,
      2
    )
  );

  // Optional: list all plans too (nice for copying into UI configs)
  const all = await SubscriptionPlan.find({})
    .select("planId role name displayName monthlyCost annualCost currency sortOrder isCustomPricing")
    .sort({ role: 1, sortOrder: 1, monthlyCost: 1 })
    .lean();

  console.log("\n=== ALL PLAN IDs (role/name -> planId) ===");
  for (const p of all) {
    console.log(
      `${p.role.padEnd(10)} ${String(p.name).padEnd(18)} -> ${p.planId}  ($${p.monthlyCost}${p.isCustomPricing ? " custom" : ""})`
    );
  }

  await mongoose.disconnect();
  console.log("\n🔌 MongoDB disconnected");
  process.exit(0);
}

run().catch(async (e) => {
  console.error("❌ Script error:", e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
