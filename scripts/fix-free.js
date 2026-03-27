require("dotenv").config();
const mongoose = require("mongoose");

const Brand = require("../models/brand");
const SubscriptionPlan = require("../models/subscription");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

async function run() {
  await mongoose.connect(MONGO_URI);

  try {
    const freePlan = await SubscriptionPlan.findOne({
      role: "Brand",
      name: "free",
      status: "active",
    });

    if (!freePlan) {
      throw new Error("Free Brand plan not found");
    }

    const featureSnapshot = (freePlan.features || []).map((feature) => ({
      key: feature.key,
      value: feature.value ?? null,
      limit: featureValueToLimit(feature.value),
      used: 0,
      note: feature.note ?? null,
      resetsEvery: null,
      resetsAt: null,
    }));

    const result = await Brand.updateMany(
      { "subscription.planName": "free" },
      {
        $set: {
          "subscription.planId": freePlan.planId,
          "subscription.planName": freePlan.name,
          "subscription.role": freePlan.role,
          "subscription.planRef": freePlan._id,
          "subscription.monthlyCost": freePlan.monthlyCost ?? 0,
          "subscription.annualCost": freePlan.annualCost ?? 0,
          "subscription.billingCycle": "monthly",
          "subscription.autoRenew": freePlan.autoRenew ?? false,
          "subscription.status": freePlan.status || "active",
          "subscription.durationMins": freePlan.durationMins ?? 43200,
          "subscription.features": featureSnapshot,
          "subscription.internalCredits": {
            used: 0,
            resetsAt: null,
          },
          subscriptionExpired: false,
        },
      }
    );

    console.log("Updated free brands:", result.modifiedCount);
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});