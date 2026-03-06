// src/scripts/contentFormat.js
require("dotenv").config();
const mongoose = require("mongoose");
const { ContentFormatModel } = require("../models/contentFormat");

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
  { format: "Reel", sortOrder: 1 },
  { format: "Story", sortOrder: 2 },
  { format: "Post", sortOrder: 3 },
  { format: "Carousel", sortOrder: 4 },
  { format: "YouTube Short", sortOrder: 5 },
  { format: "YouTube Video", sortOrder: 6 },
  { format: "Live", sortOrder: 7 },
];

const run = async () => {
  await mongoose.connect(MONGO_URI);

  // ✅ ensure only these formats remain ACTIVE (old/extra ones become inactive)
  await ContentFormatModel.updateMany({}, { $set: { isActive: false } });

  const ops = seedData.map((x) => ({
    updateOne: {
      filter: { format: x.format },
      update: { $set: { ...x, isActive: true } },
      upsert: true,
    },
  }));

  const result = await ContentFormatModel.bulkWrite(ops);

  console.log("✅ Content formats seeded (platform removed).");
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