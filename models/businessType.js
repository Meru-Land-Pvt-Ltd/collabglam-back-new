// models/businessType.js
const mongoose = require('mongoose');

const businessTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BusinessType', businessTypeSchema);
