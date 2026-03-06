// src/model/influencerTier.js
const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

// InfluencerTier: { category: "Nano", value: "1K–10K", sortOrder: 1 }
const InfluencerTierSchema = new Schema(
  {
    category: { type: String, required: true, trim: true, unique: true }, // Nano | Micro | Mid-tier | Macro | Mega
    value: { type: String, required: true, trim: true }, // "1K–10K", ...
    sortOrder: { type: Number, required: true, index: true }, // 1..n
  },
  { timestamps: true }
);

const InfluencerTierModel =
  models.InfluencerTier || model("InfluencerTier", InfluencerTierSchema);

module.exports = { InfluencerTierModel };