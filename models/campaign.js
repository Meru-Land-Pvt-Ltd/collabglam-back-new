const mongoose = require("mongoose");
const { Schema } = mongoose;

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

const locationSchema = new Schema(
  {
    ip: { type: String, default: "" },
    timezone: { type: String, default: "" },
    country: { type: String, default: "" },
    state: { type: String, default: "" },
    city: { type: String, default: "" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    source: { type: String, default: "" },
  },
  { _id: false }
);

const timelineSchema = new Schema(
  {
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
  },
  { _id: false }
);

const categoryPairSchema = new Schema(
  {
    categoryId: { type: String, default: "" },
    categoryName: { type: String, default: "" },
    subcategoryId: { type: String, default: "" },
    subcategoryName: { type: String, default: "" },
  },
  { _id: false }
);

const CampaignSchema = new Schema(
  {
    campaignsId: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toString(),
      unique: true,
      index: true,
    },

    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
    brandName: { type: String, trim: true, default: "" },

    campaignTitle: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    campaignType: { type: String, trim: true, default: "" },

    productServiceType: { type: String, trim: true, default: "" },
    campaignCategory: { type: String, trim: true, default: "" },
    campaignSubcategory: { type: String, trim: true, default: "" },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null, index: true },
    subcategoryIds: [{ type: Schema.Types.ObjectId }],

    productImages: { type: [Schema.Types.Mixed], default: [] },
    images: { type: [Schema.Types.Mixed], default: [] },
    productLink: { type: String, trim: true, default: "" },
    videoLink: { type: String, trim: true, default: "" },
    productServiceInfo: { type: [Schema.Types.Mixed], default: [] },

    campaignGoals: [{ type: Schema.Types.ObjectId, ref: "ProductServiceGoal" }],
    influencerTierIds: [{ type: Schema.Types.ObjectId, ref: "InfluencerTier" }],
    contentFormats: [{ type: Schema.Types.ObjectId, ref: "ContentFormat" }],
    contentLanguageIds: [{ type: Schema.Types.ObjectId, ref: "ContentLanguage" }],
    preferredHashtags: [{ type: Schema.Types.ObjectId, ref: "PreferredHashtag" }],
    targetCountryIds: [{ type: Schema.Types.ObjectId, ref: "Country" }],
    targetAgeRanges: [{ type: Schema.Types.ObjectId, ref: "AgeRange" }],

    numberOfInfluencers: { type: Number, default: 0, min: 0 },
    influencerTier: { type: String, trim: true, default: "" },
    minFollowers: { type: Number, default: 0, min: 0 },
    maxFollowers: { type: Number, default: 0, min: 0 },

    creatorContentLanguage: { type: String, trim: true, default: "" },
    audienceContentLanguage: { type: String, trim: true, default: "" },
    targetCountry: { type: String, trim: true, default: "" },

    campaignBudget: { type: Number, default: 0, min: 0 },
    budget: { type: Number, default: 0, min: 0 },
    influencerBudget: { type: Number, default: 0, min: 0 },

    paymentType: { type: String, trim: true, default: "Milestone" },

    platformSelection: {
      type: [String],
      default: [],
      enum: ["youtube", "instagram", "tiktok"],
    },

    additionalNotes: { type: String, trim: true, default: "" },
    hashtags: { type: [String], default: [] },

    campaignTimezone: { type: String, trim: true, default: "UTC" },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },

    createdLocation: { type: locationSchema, default: null },
    scheduledLocation: { type: locationSchema, default: null },

    timeline: { type: timelineSchema, default: () => ({}) },
    categories: { type: [categoryPairSchema], default: [] },

    productOrServiceName: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: ["draft", "scheduled", "active", "paused", "completed", "archived"],
      default: "draft",
      index: true,
    },

    publishStatus: {
      type: String,
      enum: ["draft", "scheduled", "published"],
      default: "draft",
      index: true,
    },

    campaignStatus: {
      type: String,
      enum: ["open", "paused"],
      default: "paused",
      index: true,
    },

    approvalMode: {
      type: String,
      enum: ["direct", "admin_review"],
      default: "direct",
      index: true,
    },

    statusUpdatedAt: { type: Date, default: Date.now },
    pausedAt: { type: Date, default: null },

    isActive: { type: Number, enum: [0, 1], default: 1, index: true },
    applicantCount: { type: Number, default: 0 },
    hasApplied: { type: Number, enum: [0, 1], default: 0 },
    isDraft: { type: Number, enum: [0, 1], default: 0, index: true },
    byAi: { type: Number, enum: [0, 1], default: 0, index: true },

    createdBy: { type: actorSchema, default: null },
    pendingUpdate: { type: pendingUpdateSchema, default: () => ({ status: "none" }) },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

CampaignSchema.index({ brandId: 1, createdAt: -1 });
CampaignSchema.index({ brandId: 1, status: 1 });
CampaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, createdAt: -1 });
CampaignSchema.index({ "pendingUpdate.status": 1, updatedAt: -1 });
CampaignSchema.index({ categoryId: 1, subcategoryIds: 1 });
CampaignSchema.index({ publishStatus: 1, scheduledAt: 1 });
CampaignSchema.index({ campaignStatus: 1, isDraft: 1, isActive: 1 });

module.exports =
  mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);