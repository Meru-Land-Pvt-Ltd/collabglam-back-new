'use strict';

const mongoose = require('mongoose');

const FolderItemSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['instagram', 'youtube', 'tiktok', 'other'],
      default: 'other',
      index: true,
    },

    name: { type: String, trim: true, default: '' },
    username: { type: String, trim: true, default: '' },
    handle: { type: String, trim: true, default: '' },

    followers: { type: Number, default: null },

    primaryLink: { type: String, trim: true, default: '' },
    links: [{ type: String, trim: true }],

    niche: [{ type: String, trim: true }],
    email: { type: String, trim: true, lowercase: true, default: '' },
    country: { type: String, trim: true, default: '' },

    additionalInfo: { type: String, trim: true, default: '' },
    selectionReason: { type: String, trim: true, default: '' },
    goodFit: { type: Boolean, default: false },
    rateUsd: { type: Number, default: null },
    ourFeePct: { type: Number, default: null },
    comments: { type: String, trim: true, default: '' },

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