// src/model/ageRange.js
const mongoose = require("mongoose");

const { Schema, model, models } = mongoose;

const AgeRangeSchema = new Schema(
  {
    range: { type: String, required: true, trim: true, unique: true }, // e.g. "13-17", "18-24", "65+"
  },
  { timestamps: true }
);

const AgeRangeModel = models.AgeRange || model("AgeRange", AgeRangeSchema);

module.exports = { AgeRangeModel };