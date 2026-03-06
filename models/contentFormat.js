// src/model/contentFormat.js
const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

// ContentFormat: { format: "Reel", sortOrder: 1, isActive: true }
const ContentFormatSchema = new Schema(
  {
    format: { type: String, required: true, trim: true, unique: true },
    sortOrder: { type: Number, required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const ContentFormatModel =
  models.ContentFormat || model("ContentFormat", ContentFormatSchema);

module.exports = { ContentFormatModel };