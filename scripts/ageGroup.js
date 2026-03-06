// src/scripts/ageGroup.js
require("dotenv").config();
const mongoose = require("mongoose");
const { AgeRangeModel } = require("../models/ageRange");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";

const ranges = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

async function main() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI or MONGODB_URI in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected");

  await Promise.all(
    ranges.map((r) =>
      AgeRangeModel.updateOne(
        { range: r },
        { $set: { range: r } },
        { upsert: true }
      )
    )
  );

  const final = await AgeRangeModel.find().lean();
  console.log("✅ Seeded age ranges:", final.map((x) => x.range));

  await mongoose.disconnect();
  console.log("✅ MongoDB disconnected");
}

main().catch(async (e) => {
  console.error("❌ Seed failed:", e);
  try {
    await mongoose.disconnect();
  } catch (e) {
    console.error("❌ Failed to disconnect from MongoDB:", e);
  }
  process.exit(1);
});