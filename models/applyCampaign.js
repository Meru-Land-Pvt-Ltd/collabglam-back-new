const mongoose = require('mongoose');

const applicantSchema = new mongoose.Schema(
  {
    influencerId: { type: String, required: true },
    name: { type: String, required: true },

    isShortlisted: { type: Number, enum: [0, 1], default: 0 },
    isUndicided: { type: Number, enum: [0, 1], default: 0 },
    isRejected: { type: Number, enum: [0, 1], default: 0 }
  },
  { _id: false }
);

const applyCampaignsSchema = new mongoose.Schema(
  {
    campaignId: {
      type: String,
      required: true,
      unique: true
    },
    applicants: {
      type: [applicantSchema],
      default: []
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    approved: {
      type: [applicantSchema],
      default: []
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ApplyCampaign', applyCampaignsSchema);