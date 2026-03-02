// models/NewInvitation.js
'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const HANDLE_RX      = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_ENUM  = ['youtube', 'instagram', 'tiktok'];
const STATUS_ENUM    = ['invited', 'available'];

const InvitationSchema = new mongoose.Schema(
  {
    invitationId: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
      index: true,
    },

    handle: {
      type: String,
      required: [true, 'Handle is required'],
      trim: true,
      lowercase: true,
      set: (v) => {
        if (!v) return v;
        const t = String(v).trim().toLowerCase();
        return t.startsWith('@') ? t : `@${t}`;
      },
      validate: {
        validator: (v) => HANDLE_RX.test(v || ''),
        message:
          'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: [true, 'Platform is required'],
      trim: true,
      lowercase: true,
      enum: {
        values: PLATFORM_ENUM,
        message: 'Platform must be one of: youtube, instagram, tiktok',
      },
    },

    brandId: {
      type: String,
      required: [true, 'brandId is required'],
      index: true,
      ref: 'Brand',
    },

    // 🔥 Optional campaign link (NOT required)
    campaignId: {
      type: String,
      default: null,
      index: true,
      // ref: 'Campaign', // uncomment if you have a Campaign model
    },

    // invited / available
    status: {
      type: String,
      required: true,
      enum: {
        values: STATUS_ENUM,
        message: 'Status must be one of: invited, available',
      },
      default: 'invited',
      index: true,
    },

    // 🔥 link this invitation to a MissingEmail record (if we have one)
    missingEmailId: {
      type: String,
      default: null,
      index: true,
      ref: 'MissingEmail',
    },
  },
  { timestamps: true }
);

// Unique per brand + handle + platform
InvitationSchema.index({ brandId: 1, handle: 1, platform: 1 }, { unique: true });
InvitationSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.Invitation ||
  mongoose.model('Invitations', InvitationSchema);
