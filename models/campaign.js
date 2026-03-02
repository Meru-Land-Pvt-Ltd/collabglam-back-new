const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const targetAudienceSchema = new mongoose.Schema({
  age: {
    MinAge: { type: Number },
    MaxAge: { type: Number }
  },
  gender: {
    type: Number,
    enum: [0, 1, 2],  // 0 → Female, 1 → Male, 2 → All
    required: true,
    default: 2
  },
  locations: [
    {
      countryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Country',
        required: true
      },
      countryName: {
        type: String,
        required: true
      }
    }
  ]
}, { _id: false });

const actorSchema = new mongoose.Schema({
  role: { type: String, enum: ["brand", "admin"], required: true },
  userId: { type: String, default: "" },
}, { _id: false });

const pendingUpdateSchema = new mongoose.Schema({
  status: { type: String, enum: ["none", "pending", "approved", "rejected"], default: "none", index: true },
  patch: { type: mongoose.Schema.Types.Mixed, default: null },
  updatedBy: { type: actorSchema, default: null },
  updatedAt: { type: Date, default: null },
  reviewedBy: { type: actorSchema, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: "" },
}, { _id: false });

const categorySelectionSchema = new mongoose.Schema({
  categoryId: { type: Number, required: true, index: true },
  categoryName: { type: String, required: true },
  subcategoryId: { type: String, required: true, index: true },
  subcategoryName: { type: String, required: true }
}, { _id: false });

const campaignSchema = new mongoose.Schema({
  brandId: { type: String, required: true, default: uuidv4 },
  campaignsId: { type: String, required: true, unique: true, default: uuidv4 },
  brandName: { type: String, required: true },
  productOrServiceName: { type: String, required: true },
  description: { type: String, default: '' },
  targetAudience: {
    type: targetAudienceSchema,
    default: () => ({ age: { MinAge: 0, MaxAge: 0 }, gender: 2, location: '' })
  },
  categories: [categorySelectionSchema],
  goal: {
    type: String,
    enum: ['Brand Awareness', 'Sales', 'Engagement'],
    required: true
  },
  campaignType: { type: String, default: '' },
  creativeBriefText: { type: String, default: '' },
  budget: { type: Number, default: 0 },
  influencerBudget: { type: Number, default: 0 },
  timeline: { startDate: { type: Date }, endDate: { type: Date } },
  images: [{ type: String }],
  creativeBrief: [{ type: String }],
  additionalNotes: { type: String, default: '' },

  campaignStatus: { type: String, enum: ['open', 'paused'], default: 'open', index: true },
  statusUpdatedAt: { type: Date, default: Date.now },
  pausedAt: { type: Date, default: null },
  isActive: { type: Number, enum: [0, 1], default: 1 },
  applicantCount: { type: Number, default: 0 },
  hasApplied: { type: Number, enum: [0, 1], default: 0 },
  
  isDraft: { type: Number, enum: [0, 1], default: 0 },
  
  // ✅ ENFORCES THE NEW WORKFLOW STATES
  publishStatus: {
    type: String,
    enum: ["draft", "pending_brand_review", "brand_confirmed", "published"],
    default: "published",
    index: true
  },
  
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: actorSchema, default: null },
  approvalMode: { type: String, enum: ["direct", "admin_review"], default: "direct", index: true },
  pendingUpdate: { type: pendingUpdateSchema, default: () => ({ status: "none" }) },
}, { timestamps: true });

campaignSchema.index({ 'categories.subcategoryId': 1 });
campaignSchema.index({ 'categories.categoryId': 1 });
campaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, campaignStatus: 1, createdAt: -1 });
campaignSchema.index({ approvalMode: 1, "pendingUpdate.status": 1, updatedAt: -1 });

const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', campaignSchema);
module.exports = Campaign;