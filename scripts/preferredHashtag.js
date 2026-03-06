// src/scripts/preferredHashtag.js
require("dotenv").config();
const mongoose = require("mongoose");
const { PreferredHashtagModel } = require("../models/preferredHashtag");

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URI) {
  throw new Error(
    "Missing Mongo connection string. Set MONGODB_URI (or MONGO_URI / MONGO_URL / DATABASE_URL)."
  );
}

const normalizeTag = (t) => {
  const s = String(t || "").trim();
  if (!s) return "";
  return s.startsWith("#") ? s : `#${s}`;
};

// ✅ Includes your UI hashtags + more popular ones
const tags = [
  // --- from UI ---
  "#Tech",
  "#Story",
  "#UGC",
  "#Beauty",
  "#Fashion",
  "#Gaming",

  // --- common/popular ---
  "#Lifestyle",
  "#Travel",
  "#Food",
  "#Fitness",
  "#Health",
  "#Wellness",
  "#Skincare",
  "#Makeup",
  "#OOTD",
  "#StreetStyle",
  "#Luxury",
  "#Photography",
  "#Videography",
  "#Cinematic",
  "#Reels",
  "#Shorts",
  "#Vlog",
  "#DailyVlog",
  "#Motivation",
  "#Productivity",
  "#Entrepreneur",
  "#Startup",
  "#Business",
  "#Finance",
  "#Education",
  "#HowTo",
  "#Tips",
  "#Review",
  "#TechReview",
  "#Unboxing",
  "#Gadgets",
  "#Smartphone",
  "#AI",
  "#ContentCreator",
  "#Creator",
  "#Influencer",
  "#BrandCollab",
  "#Collaboration",
  "#Giveaway",

  // --- entertainment ---
  "#Music",
  "#Comedy",
  "#Dance",
  "#Art",
  "#Design",
  "#Movies",
  "#Anime",
  "#Books",

  // --- sports ---
  "#Sports",
  "#Cricket",
  "#Football",
  "#Esports",
  "#GamingSetup",

  // --- home / diy ---
  "#HomeDecor",
  "#InteriorDesign",
  "#DIY",
  "#KitchenHacks",
  "#Minimalism",

  // --- pets ---
  "#Pets",
  "#DogLovers",
  "#CatLovers",
].map(normalizeTag);

const seedData = tags
  .filter(Boolean)
  .map((tag, idx) => ({ tag, sortOrder: idx + 1 }));

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const ops = seedData.map((x) => ({
    updateOne: {
      filter: { tag: x.tag },
      update: { $set: { ...x, isActive: true } },
      upsert: true,
    },
  }));

  const result = await PreferredHashtagModel.bulkWrite(ops, { ordered: false });
  const totalInDB = await PreferredHashtagModel.countDocuments();

  console.log("✅ Preferred hashtags seeded:", {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
    totalInDB,
  });

  await mongoose.disconnect();
  console.log("✅ Disconnected");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});