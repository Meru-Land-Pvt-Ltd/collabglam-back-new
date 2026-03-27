'use strict';

const mongoose = require('mongoose');

const SIGNUP_STATUS = {
  NOT_SIGNED_UP: 'not_signed_up',
  SIGNED_UP: 'signed_up',
};

const CONVERSION_PLAN = {
  NOT_CONVERTED: 'not_converted',
  TRIAL_PACK: 'trial_pack',
  SUBSCRIPTION: 'subscription',
};

const BrandOutreachSchema = new mongoose.Schema(
  {
    brandName: { type: String, trim: true, required: true, index: true },
    website: { type: String, trim: true, default: '' },

    roleOfPerson: { type: String, trim: true, default: '' },
    emailOfPerson: { type: String, trim: true, lowercase: true, default: '', index: true },
    personalization: { type: String, trim: true, default: '' },

    outreached: { type: Boolean, default: false },
    dateLastContact: { type: Date, default: null },

    reply: { type: Boolean, default: false },
    replyText: { type: String, trim: true, default: '' },
    repliedAt: { type: Date, default: null },

    followUp1: { type: Boolean, default: false },
    followUp1SentAt: { type: Date, default: null },

    followUp2: { type: Boolean, default: false },
    followUp2SentAt: { type: Date, default: null },

    followUp3: { type: Boolean, default: false },
    followUp3SentAt: { type: Date, default: null },

    notes: { type: String, trim: true, default: '' },

    signupStatus: {
      type: String,
      enum: Object.values(SIGNUP_STATUS),
      default: SIGNUP_STATUS.NOT_SIGNED_UP,
      index: true,
    },

    conversionToPlan: {
      type: String,
      enum: Object.values(CONVERSION_PLAN),
      default: CONVERSION_PLAN.NOT_CONVERTED,
      index: true,
    },

    moveToNetwork: { type: Boolean, default: false },
    movedToNetworkAt: { type: Date, default: null },

    linkedNetworkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BrandNetwork',
      default: null,
      index: true,
    },

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
  },
  { timestamps: true }
);

BrandOutreachSchema.index(
  { brandName: 1, emailOfPerson: 1 },
  { unique: false }
);

module.exports = {
  BrandOutreach: mongoose.model('BrandOutreach', BrandOutreachSchema),
  BRAND_SIGNUP_STATUS: SIGNUP_STATUS,
  BRAND_CONVERSION_PLAN: CONVERSION_PLAN,
};