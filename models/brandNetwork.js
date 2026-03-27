'use strict';

const mongoose = require('mongoose');

const PLATFORM_OPTIONS = ['instagram', 'youtube', 'tiktok', 'multiple'];
const INFLUENCER_SIZE = ['nano', 'micro', 'mid', 'macro', 'celebrity'];
const CONTENT_TYPES = ['reel', 'post', 'story', 'video', 'mix'];
const PLAN_TYPES = ['trial_pack', 'subscription'];
const SUBSCRIPTION_STATUS = ['trial_active', 'active', 'expired', 'cancelled'];

const BrandNetworkSchema = new mongoose.Schema(
  {
    sourceOutreachId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BrandOutreach',
      default: null,
      index: true,
    },

    brandName: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },

    website: {
      type: String,
      trim: true,
      default: '',
    },

    contacts: {
      type: String,
      trim: true,
      default: '',
    },

    employeeCount: {
      type: Number,
      default: null,
    },

    monthlyBudget: {
      type: Number,
      default: null,
    },

    targetRegions: {
      type: [String],
      default: [],
    },

    platforms: {
      type: [String],
      enum: PLATFORM_OPTIONS,
      default: [],
    },

    influencerSize: {
      type: String,
      enum: INFLUENCER_SIZE,
      default: null,
    },

    influencerCategory: {
      type: String,
      trim: true,
      default: '',
    },

    numberOfInfluencers: {
      type: Number,
      default: null,
    },

    campaignRequirement: {
      type: String,
      trim: true,
      default: '',
    },

    contentType: {
      type: String,
      enum: CONTENT_TYPES,
      default: null,
    },

    campaignTimeline: {
      startDate: {
        type: Date,
        default: null,
      },
      endDate: {
        type: Date,
        default: null,
      },
    },

    planType: {
      type: String,
      enum: PLAN_TYPES,
      default: null,
    },

    subscriptionStatus: {
      type: String,
      enum: SUBSCRIPTION_STATUS,
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      default: '',
    },

    createdByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    updatedByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = {
  BrandNetwork:
    mongoose.models.BrandNetwork ||
    mongoose.model('BrandNetwork', BrandNetworkSchema),
};