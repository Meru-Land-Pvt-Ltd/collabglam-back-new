// models/Campaign.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const { Schema } = mongoose;

/** ---------- Extra sub-schemas (from old model) ---------- */
const targetAudienceSchema = new Schema(
  {
    age: {
      MinAge: { type: Number, default: 0 },
      MaxAge: { type: Number, default: 0 },
    },
    gender: {
      type: Number,
      enum: [0, 1, 2], // 0 → Female, 1 → Male, 2 → All
      required: true,
      default: 2,
    },
    locations: [
      {
        countryId: { type: Schema.Types.ObjectId, ref: "Country", required: true },
        countryName: { type: String, required: true },
      },
    ],
  },
  { _id: false }
);

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

const categorySelectionSchema = new Schema(
  {
    categoryId: { type: Number, required: true, index: true },
    categoryName: { type: String, required: true },
    subcategoryId: { type: String, required: true, index: true },
    subcategoryName: { type: String, required: true },
  },
  { _id: false }
);

/** ---------- Final Campaign Schema (create fields kept as-is + old workflow details added) ---------- */
const CampaignSchema = new Schema(
  {
    // ✅ REQUIRED (create campaign) - kept as it is
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },

    campaignTitle: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    productServiceType: { type: String, trim: true },

    // strings (manual allowed)
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

    // hashtags as strings
    hashtags: { type: [String], default: [] },

    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed", "archived"],
      default: "draft",
      index: true,
    },

    // ✅ ADDED (old model details you still need)
    campaignsId: { type: String, required: true, unique: true, default: uuidv4 }, // public UUID

    brandName: { type: String, trim: true, default: "" },
    productOrServiceName: { type: String, trim: true, default: "" },

    // old audience + categories
    targetAudience: {
      type: targetAudienceSchema,
      default: () => ({ age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] }),
    },
    categories: { type: [categorySelectionSchema], default: [] },

    // old goal/brief fields
    goal: {
      type: String,
      enum: ["Brand Awareness", "Sales", "Engagement"],
      default: "Brand Awareness",
      index: true,
    },
    campaignType: { type: String, trim: true, default: "" },
    creativeBriefText: { type: String, trim: true, default: "" },
    creativeBrief: { type: [String], default: [] },
    images: { type: [String], default: [] }, // legacy images

    // old timeline/budgets (optional compat)
    timeline: {
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
    },
    budget: { type: Number, default: 0, min: 0 }, // legacy
    influencerBudget: { type: Number, default: 0, min: 0 },

    // old workflow flags (the ones you mentioned)
    campaignStatus: { type: String, enum: ["open", "paused"], default: "open", index: true },
    statusUpdatedAt: { type: Date, default: Date.now },
    pausedAt: { type: Date, default: null },

    isActive: { type: Number, enum: [0, 1], default: 1, index: true },
    applicantCount: { type: Number, default: 0 },
    hasApplied: { type: Number, enum: [0, 1], default: 0 },
    isDraft: { type: Number, enum: [0, 1], default: 0, index: true },

    // publish workflow (old)
    publishStatus: {
      type: String,
      enum: ["draft", "pending_brand_review", "brand_confirmed", "published"],
      default: "draft",
      index: true,
    },

    // admin approval workflow (old)
    createdBy: { type: actorSchema, default: null },
    approvalMode: { type: String, enum: ["direct", "admin_review"], default: "direct", index: true },
    pendingUpdate: { type: pendingUpdateSchema, default: () => ({ status: "none" }) },
  },
  { timestamps: true }
);

/** ---------- Indexes (merged) ---------- */
CampaignSchema.index({ brandId: 1, createdAt: -1 });
CampaignSchema.index({ brandId: 1, status: 1 });

CampaignSchema.index({ "categories.subcategoryId": 1 });
CampaignSchema.index({ "categories.categoryId": 1 });

CampaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, campaignStatus: 1, createdAt: -1 });
CampaignSchema.index({ approvalMode: 1, "pendingUpdate.status": 1, updatedAt: -1 });

module.exports = mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);