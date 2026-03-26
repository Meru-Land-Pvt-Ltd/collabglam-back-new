const mongoose = require('mongoose');

const applicantSchema = new mongoose.Schema(
  {
    influencerId: { type: String, required: true },
    name: { type: String, required: true },

    isShortlisted: { type: Number, enum: [0, 1], default: 0 },
    isUndicided: { type: Number, enum: [0, 1], default: 0 },
    isRejected: { type: Number, enum: [0, 1], default: 0 },
    statusBrand: { type: String, enum: ['contract-send', 'contractAccept', 'rejected','contract-resend','changerequirement','under-brand-review'], default: '' },
    statusInfluencer: { type: String, enum: ['under-influencer-review', 'rejected','update-contract','update-review',"contractAccept"], default: '' },
    contractId: {
      type: String,
      default: ''
    },
    appliedAt: {
      type: Date,
      default: Date.now
    }
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