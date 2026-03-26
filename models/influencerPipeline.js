'use strict';

const mongoose = require('mongoose');

const STAGES = {
  OUTREACH: 'outreach',
  ROSTER: 'roster',
  PITCH: 'pitch',
  SHORTLISTED: 'shortlisted',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CLOSED: 'closed',
  CONTRACT_SENT: 'contract_sent',
  CONTRACT_SIGNED: 'contract_signed',
  COMPLETED: 'completed',
};

const SOURCE_TYPES = {
  MODASH: 'modash',
  YOUTUBE: 'youtube',
  CSV: 'csv',
  SHAREMITRA: 'sharemitra',
  MANUAL: 'manual',
};

const MilestoneSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, required: true },
    amount: { type: Number, default: null },
    deliverable: { type: String, trim: true, default: '' },
    dueDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ['released', 'submitted', 'approved', 'paid'],
      default: 'released',
    },

    submissionLink: { type: String, trim: true, default: '' },
    revisionNotes: { type: String, trim: true, default: '' },

    releasedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { _id: true, timestamps: true }
);

const BrandPortalSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, default: '' },
    url: { type: String, trim: true, default: '' },
    generatedAt: { type: Date, default: null },
    sharedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { _id: false }
);

const InfluencerPipelineSchema = new mongoose.Schema(
  {
    linkedInfluencerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      default: null,
      index: true,
    },
    campaignInvitationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CampaignInvitation',
      default: null,
    },
    campaignInvitationStatus: {
      type: String,
      enum: ['', 'sent', 'accepted', 'reject', 'failed'],
      default: '',
    },
    campaignInvitationSentAt: {
      type: Date,
      default: null,
    },
    hasInvited: {
      type: Boolean,
      default: false,
      index: true,
    },
    hasInvitedAt: {
      type: Date,
      default: null,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(STAGES),
      default: STAGES.OUTREACH,
      index: true,
    },

    sourceType: {
      type: String,
      enum: Object.values(SOURCE_TYPES),
      required: true,
      index: true,
    },

    sourceRefId: { type: String, trim: true, default: '' },

    platform: {
      type: String,
      enum: ['youtube', 'instagram', 'tiktok', 'other'],
      default: 'other',
      index: true,
    },

    // base identity
    name: { type: String, trim: true, default: '' },
    username: { type: String, trim: true, default: '' },
    handle: { type: String, trim: true, default: '' },
    userId: { type: String, trim: true, default: '' },

    followers: { type: Number, default: null },
    links: [{ type: String, trim: true }],
    primaryLink: { type: String, trim: true, default: '' },
    picture: { type: String, trim: true, default: '' },

    niche: [{ type: String, trim: true }],
    description: { type: String, trim: true, default: '' }, // AI Info / manual description
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },

    country: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    language: { type: String, trim: true, default: '' },

    // phase 1 manual scoring
    imeRating: {
      type: String,
      trim: true,
      default: '', // 1-5 / High-Medium-Low
    },
    nicheFitNotes: { type: String, trim: true, default: '' },
    engagementNotes: { type: String, trim: true, default: '' },
    redFlags: { type: String, trim: true, default: '' },
    internalNotes: { type: String, trim: true, default: '' },

    // outreach
    outreachDate: { type: Date, default: null },
    outreached: { type: Boolean, default: false },
    followUp1SentAt: { type: Date, default: null },
    followUp2SentAt: { type: Date, default: null },
    replyText: { type: String, trim: true, default: '' },
    repliedAt: { type: Date, default: null },

    // roster
    demographics: { type: String, trim: true, default: '' },
    engagementRate: { type: Number, default: null },
    deliverables: { type: String, trim: true, default: '' },
    rates: { type: Number, default: null },
    mediaKit: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },

    // pitch
    additionalInfo: { type: String, trim: true, default: '' },
    selectionReason: { type: String, trim: true, default: '' },
    goodFit: { type: Boolean, default: false },
    rateUsd: { type: Number, default: null },
    ourFeePct: { type: Number, default: null },
    comments: { type: String, trim: true, default: '' },

    // post-pitch / admin
    contractStatus: {
      type: String,
      enum: ['', 'sent', 'brand_signed', 'influencer_signed', 'complete'],
      default: '',
    },

    milestones: [MilestoneSchema],
    portal: { type: BrandPortalSchema, default: () => ({}) },

    archivedAt: { type: Date, default: null },

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

    rawSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

InfluencerPipelineSchema.index(
  {
    campaignId: 1,
    sourceType: 1,
    sourceRefId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      sourceRefId: { $exists: true, $type: 'string', $ne: '' },
    },
  }
);

module.exports = {
  InfluencerPipeline: mongoose.model('InfluencerPipeline', InfluencerPipelineSchema),
  PIPELINE_STAGES: STAGES,
  PIPELINE_SOURCES: SOURCE_TYPES,
};