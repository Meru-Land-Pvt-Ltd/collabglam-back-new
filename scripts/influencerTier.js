// src/scripts/influencerTier.js
require("dotenv").config();
const mongoose = require("mongoose");
const { InfluencerTierModel } = require("../models/influencerTier");

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URI) {
  throw new Error(
    "Missing Mongo connection string. Set MONGO_URI (or MONGODB_URI / MONGO_URL / DATABASE_URL)."
  );
}

const seedData = [
  { category: "Nano", value: "1K–10K", sortOrder: 1 },
  { category: "Micro", value: "10K–50K", sortOrder: 2 },
  { category: "Mid-tier", value: "50K–250K", sortOrder: 3 },
  { category: "Macro", value: "250K–1M", sortOrder: 4 },
  { category: "Mega", value: "1M+", sortOrder: 5 },
];

const run = async () => {
  await mongoose.connect(MONGO_URI);

  const ops = seedData.map((x) => ({
    updateOne: {
      filter: { category: x.category },
      update: { $set: { ...x, isActive: true } }, // note: keep/remove isActive depending on schema
      upsert: true,
    },
  }));

  const result = await InfluencerTierModel.bulkWrite(ops);

  console.log("✅ Influencer tiers seeded.");
  console.log({
    upserted: result.upsertedCount,
    modified: result.modifiedCount,
    matched: result.matchedCount,
  });

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("❌ Seeding failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});