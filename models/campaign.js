// models/Campaign.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/** Admin / review helpers */
const actorSchema = new Schema(
  {
    role: { type: String, enum: ["brand", "admin"], required: true },
    userId: { type: String, default: "" },
  },
  { _id: false }
);

const pendingUpdateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
      index: true,
    },
    patch: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: actorSchema, default: null },
    updatedAt: { type: Date, default: null },
    reviewedBy: { type: actorSchema, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
  },
  { _id: false }
);

const CampaignSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },

    campaignTitle: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    productServiceType: { type: String, trim: true },
    campaignCategory: { type: String, trim: true },
    campaignSubcategory: { type: String, trim: true },

    productImages: { type: [Schema.Types.Mixed], default: [] },
    productLink: { type: String, trim: true },
    productServiceInfo: { type: [Schema.Types.Mixed], default: [] },

    numberOfInfluencers: { type: Number, default: 0, min: 0 },
    influencerTier: { type: String, trim: true },
    minFollowers: { type: Number, default: 0, min: 0 },
    maxFollowers: { type: Number, default: 0, min: 0 },
    contentFormats: { type: [Schema.Types.Mixed], default: [] },
    creatorContentLanguage: { type: String, trim: true },

    campaignBudget: { type: Number, default: 0, min: 0 },
    paymentType: { type: String, trim: true, default: "Affiliates" },

    platformSelection: { type: [Schema.Types.Mixed], default: [] },
    targetCountry: { type: String, trim: true },
    audienceContentLanguage: { type: String, trim: true },
    additionalNotes: { type: String, trim: true },

    hashtags: { type: [String], default: [] },

    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed", "archived"],
      default: "draft",
      index: true,
    },

    brandName: { type: String, trim: true, default: "" },
    influencerBudget: { type: Number, default: 0, min: 0 },
    statusUpdatedAt: { type: Date, default: Date.now },
    pausedAt: { type: Date, default: null },

    isActive: { type: Number, enum: [0, 1], default: 1, index: true },
    applicantCount: { type: Number, default: 0 },
    hasApplied: { type: Number, enum: [0, 1], default: 0 },
    isDraft: { type: Number, enum: [0, 1], default: 0, index: true },

    // Keep for admin create / admin review workflow
    createdBy: { type: actorSchema, default: null },
    pendingUpdate: { type: pendingUpdateSchema, default: () => ({ status: "none" }) },
  },
  { timestamps: true }
);

/** Indexes */
CampaignSchema.index({ brandId: 1, createdAt: -1 });
CampaignSchema.index({ brandId: 1, status: 1 });
CampaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, createdAt: -1 });
CampaignSchema.index({ "pendingUpdate.status": 1, updatedAt: -1 });

module.exports = mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);