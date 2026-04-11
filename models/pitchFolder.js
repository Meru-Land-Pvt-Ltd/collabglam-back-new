'use strict';

const mongoose = require('mongoose');

const RateCardHistorySchema = new mongoose.Schema(
  {
    field: {
      type: String,
      enum: ['influencerRateCard', 'platformRateCard'],
      required: true,
    },
    previousValue: { type: String, trim: true, default: '' },
    newValue: { type: String, trim: true, default: '' },
    changedAt: { type: Date, default: Date.now },
    changedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
  },
  { _id: true }
);

const MediaKitSchema = new mongoose.Schema(
  {
    s3Key: { type: String, trim: true, default: '' },
    fileName: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: 'application/pdf' },
    size: { type: Number, default: null },
    uploadedAt: { type: Date, default: null },
    uploadedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
    showToBrand: { type: Boolean, default: false },
    requestStatus: {
      type: String,
      enum: ['none', 'requested', 'approved', 'rejected'],
      default: 'none',
    },
    requestedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
  },
  { _id: false }
);

const MediaKitLinkSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, default: '' },
    generatedAt: { type: Date, default: null },
    generatedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
    showToBrand: { type: Boolean, default: false },
    requestStatus: {
      type: String,
      enum: ['none', 'requested', 'approved', 'rejected'],
      default: 'none',
    },
    requestedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
  },
  { _id: false }
);

const FolderItemSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['instagram', 'youtube', 'tiktok'],
      default: 'instagram',
      index: true,
    },

    name: { type: String, trim: true, default: '' },
    handle: { type: String, trim: true, default: '' },

    followers: { type: Number, default: null },

    primaryLink: { type: String, trim: true, default: '' },
    links: [{ type: String, trim: true }],

    niche: [{ type: String, trim: true }],
    email: { type: String, trim: true, lowercase: true, default: '' },
    country: { type: String, trim: true, default: '' },

    selectionReason: { type: String, trim: true, default: '' },
    goodFit: { type: Boolean, default: false },

    influencerRateCard: { type: String, trim: true, default: '' },
    platformRateCard: { type: String, trim: true, default: '' },
    rateCardCurrency: { type: String, trim: true, default: 'USD' },

    ourFeePct: { type: Number, default: null },
shippingAddress: { type: String, trim: true, default: '' },

    mediaKit: {
      type: MediaKitSchema,
      default: () => ({}),
    },

    mediaKitLink: {
      type: MediaKitLinkSchema,
      default: () => ({}),
    },

    rateCardHistory: {
      type: [RateCardHistorySchema],
      default: [],
    },

    sourcePipelineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InfluencerPipeline',
      default: null,
    },

    createdByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
    updatedByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

const FolderShareSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, default: '' },
    url: { type: String, trim: true, default: '' },
    generatedAt: { type: Date, default: null },
    sharedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },
  },
  { _id: false }
);

const PitchFolderSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, required: true, index: true },
    slug: { type: String, trim: true, default: '', index: true },
    description: { type: String, trim: true, default: '' },

    brandVisibleItemCount: { type: Number, default: null },
    showFullListToBrand: { type: Boolean, default: true },

    items: [FolderItemSchema],

    share: {
      type: FolderShareSchema,
      default: () => ({}),
    },

    createdByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
      index: true,
    },
    updatedByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Master',
      default: null,
    },

    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

PitchFolderSchema.index(
  { 'share.token': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      'share.token': { $exists: true, $type: 'string', $ne: '' },
    },
  }
);

PitchFolderSchema.index({ createdByAdmin: 1, archivedAt: 1, updatedAt: -1 });

module.exports = mongoose.model('PitchFolder', PitchFolderSchema);