'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const InfluencerProfileSchema = new mongoose.Schema(
  {
    // ✅ Unique internal id using UUID
    handleId: {
      type: String,
      unique: true,
      index: true,
      required: true,
      default: () => uuidv4(),
    },

    platform: { type: String, required: true, default: 'youtube', index: true },

    handle: { type: String, required: true, index: true },      // "@mrbeast"
    channelId: { type: String, required: true, index: true },   // "UC...."

    title: { type: String, default: '' },
    description: { type: String, default: '' },
    country: { type: String, default: null },
    defaultLanguage: { type: String, default: null },
    keywords: { type: String, default: '' },
    bannerUrl: { type: String, default: null },
    thumbnails: { type: mongoose.Schema.Types.Mixed, default: null },

    topicCategories: { type: [String], default: [] },
    topicLabels: { type: [String], default: [] },

    subscriberCount: { type: Number, default: null },
    totalViewCount: { type: Number, default: null },
    totalVideoCount: { type: Number, default: null },

    lastVideosLimit: { type: Number, default: 15 },
    lastVideos: {
      type: [
        {
          videoId: String,
          title: String,
          publishedAt: Date,
          viewCount: Number,
          likeCount: Number,
          commentCount: Number,
          duration: String,
        },
      ],
      default: [],
    },

    avgViewsLast15: { type: Number, default: null },
    engagementRateLast15: { type: Number, default: null },
    uploadFrequencyPerWeek: { type: Number, default: null },
    avgDaysBetweenUploads: { type: Number, default: null },

    lastUploadAt: { type: Date, default: null },
    lastVideoId: { type: String, default: null },
    lastVideoTitle: { type: String, default: null },

    instagramHandle: { type: String, default: null },

    // ✅ manual fields (NEW)
    email: { type: String, default: null },
    lastSponsor: { type: String, default: null },
    managedByAgency: { type: Boolean, default: null }, // null = unknown
    topAudienceCountry: { type: String, default: null },
    averageAudienceAge: { type: Number, default: null }, // numeric avg age
    lastContactedAt: { type: Date, default: null },
    followUpDates: { type: [Date], default: [] },
    workingHandle: { type: String, default: null },

    rawChannel: { type: mongoose.Schema.Types.Mixed, default: null },
    rawPlaylists: { type: [mongoose.Schema.Types.Mixed], default: [] },

    syncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ✅ prevent duplicates per platform+handle
InfluencerProfileSchema.index({ platform: 1, handle: 1 }, { unique: true });

module.exports = mongoose.model('InfluencerProfile', InfluencerProfileSchema);