// src/model/preferredHashtag.js
const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

// PreferredHashtag: { tag: "#Tech" }
const PreferredHashtagSchema = new Schema(
  {
    tag: { type: String, required: true, trim: true, unique: true },
    // NOTE: script uses sortOrder + isActive, so we include them here to match.
    sortOrder: { type: Number, required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const PreferredHashtagModel =
  models.PreferredHashtag || model("PreferredHashtag", PreferredHashtagSchema);

module.exports = { PreferredHashtagModel };