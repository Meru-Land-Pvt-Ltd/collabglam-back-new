require("dotenv").config();
const mongoose = require("mongoose");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");

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

const seedGoals = [
  "Awareness",
  "Engagement Boost",
  "Product Launch",
  "Sales / Conversions",
  "Community",
  "UGC Creation",
  "App Installs",
  "Traffic",
  "Events",
  "Others",
].map((goal, idx) => ({ goal, sortOrder: idx + 1 }));

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const ops = seedGoals.map((x) => ({
    updateOne: {
      filter: { goal: x.goal },
      update: { $set: { ...x, isActive: true } },
      upsert: true,
    },
  }));

  const result = await ProductServiceGoalModel.bulkWrite(ops, { ordered: false });
  const totalInDB = await ProductServiceGoalModel.countDocuments();

  console.log("Product/Service goals seeded:", {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
    totalInDB,
  });

  await mongoose.disconnect();
  console.log("Disconnected");
};

run().catch(async (err) => {
  console.error("Seed failed:", err);
  try {
    await mongoose.disconnect();
  } catch (e) {}
  process.exit(1);
});