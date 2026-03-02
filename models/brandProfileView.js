// models/brandProfileView.js
const mongoose = require('mongoose');

const brandProfileViewSchema = new mongoose.Schema(
  {
    brandId: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      required: true,
      enum: ['instagram', 'youtube', 'tiktok'],
    },
    userId: {
      type: String,
      required: true, // Modash userId we pass in frontendReport
    },
    influencerId: {
      type: String,
    },
    // e.g. "2025-12" – one record per brand/profile per calendar month
    periodKey: {
      type: String,
      required: true,
    },
    firstViewedAt: {
      type: Date,
      default: Date.now,
    },
    lastViewedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// A brand should only ever pay once per platform+userId+periodKey
brandProfileViewSchema.index(
  { brandId: 1, platform: 1, userId: 1, periodKey: 1 },
  { unique: true, name: 'brand_profile_period_unique' }
);

module.exports = mongoose.model('BrandProfileView', brandProfileViewSchema);
