// models/modash.js
'use strict';

const mongoose = require('mongoose');

const UUIDv4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------------------------- Shared sub-schemas --------------------------- */

const weightItemSchema = new mongoose.Schema(
  {
    code: String,
    name: String,
    weight: Number,
  },
  { _id: false }
);

const categoryLinkSchema = new mongoose.Schema(
  {
    categoryId: { type: Number, required: true },
    categoryName: { type: String, required: true, trim: true },
    subcategoryId: {
      type: String,
      required: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)'],
    },
    subcategoryName: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const userLiteSchema = new mongoose.Schema(
  {
    userId: String,
    fullname: String,
    username: String,
    url: String,
    picture: String,
    followers: Number,
    engagements: Number,
  },
  { _id: false }
);

const sponsorSchema = new mongoose.Schema(
  {
    domain: String,
    logo_url: String,
    name: String,
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    id: String,
    text: String,
    url: String,
    created: String,
    likes: Number,
    comments: Number,
    views: Number,
    video: String,
    image: String,
    thumbnail: String,
    type: String,
    title: String,
    mentions: [String],
    hashtags: [String],
    sponsors: [sponsorSchema],
  },
  { _id: false }
);

const audienceSchema = new mongoose.Schema(
  {
    notable: Number,
    genders: [weightItemSchema],
    geoCountries: [weightItemSchema],
    ages: [weightItemSchema],
    gendersPerAge: [{ code: String, male: Number, female: Number }],
    languages: [weightItemSchema],
    notableUsers: [userLiteSchema],
    audienceLookalikes: [userLiteSchema],
    geoCities: [{ name: String, weight: Number }],
    geoStates: [{ name: String, weight: Number }],
    credibility: Number,
    interests: [{ name: String, weight: Number }],
    brandAffinity: [{ name: String, weight: Number }],
    audienceReachability: [weightItemSchema],
    audienceTypes: [weightItemSchema],
    ethnicities: [weightItemSchema],
  },
  { _id: false }
);

/* --------------------------- Modash Profile ------------------------------ */

const modashSchema = new mongoose.Schema(
  {
    // Optional link to your main Influencer document
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      required: false,
      index: true,
    },

    // String version of influencer ID (for display/reference)
    influencerId: {
      type: String,
      required: false,
      index: true,
    },

    // Provider info
    provider: {
      type: String,
      enum: ['youtube', 'tiktok', 'instagram'],
      required: true,
      index: true,
    },

    // PRIMARY identity (together with provider)
    userId: {
      type: String,
      required: true,
      index: true,
    },

    // Profile basics
    username: String,
    fullname: String,
    handle: String,
    url: String,
    picture: String,

    // Metrics
    followers: Number,
    engagements: Number,
    engagementRate: Number,
    averageViews: Number,

    // State/meta
    isPrivate: Boolean,
    isVerified: Boolean,
    accountType: String,
    secUid: String,

    // Localization
    city: String,
    state: String,
    country: String,
    ageGroup: String,
    gender: String,

    // language can be string or object
    language: mongoose.Schema.Types.Mixed,

    // Content stats & posts
    statsByContentType: mongoose.Schema.Types.Mixed,
    stats: mongoose.Schema.Types.Mixed,

    recentPosts: [postSchema],
    popularPosts: [postSchema],

    // Counts (normalized)
    postsCount: Number,
    avgLikes: Number,
    avgComments: Number,
    avgViews: Number,
    avgReelsPlays: Number,
    totalLikes: Number,
    totalViews: Number,

    // Bio
    bio: String,

    // Categories (your own classification)
    categories: { type: [categoryLinkSchema], default: [] },

    // Tags / brand affinity
    hashtags: [mongoose.Schema.Types.Mixed],
    mentions: [mongoose.Schema.Types.Mixed],
    brandAffinity: [mongoose.Schema.Types.Mixed],

    // Audience (typed but flexible)
    audience: audienceSchema,
    audienceCommenters: audienceSchema,
    lookalikes: [userLiteSchema],

    // Paid/sponsored
    sponsoredPosts: [postSchema],
    paidPostPerformance: Number,
    paidPostPerformanceViews: Number,
    sponsoredPostsMedianViews: Number,
    sponsoredPostsMedianLikes: Number,
    nonSponsoredPostsMedianViews: Number,
    nonSponsoredPostsMedianLikes: Number,

    // Misc extras
    audienceExtra: mongoose.Schema.Types.Mixed,

    // Full raw payload (may be trimmed)
    providerRaw: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
  }
);

/* ------------------------------ Indexes ---------------------------------- */

// PRIMARY unique constraint: userId + provider
modashSchema.index(
  { userId: 1, provider: 1 },
  {
    unique: true,
    name: 'userId_provider_unique',
  }
);

// Index for influencer string id (non-unique)
modashSchema.index(
  { influencerId: 1 },
  {
    sparse: true,
    name: 'influencerId_lookup',
  }
);

// Common query helper
modashSchema.index(
  { provider: 1, username: 1 },
  {
    name: 'provider_username_lookup',
  }
);

/* ------------------------------ Pre-save Hook --------------------------- */

modashSchema.pre('save', function (next) {
  if (!this.userId) {
    return next(new Error('userId is required for ModashProfile'));
  }
  if (!this.provider) {
    return next(new Error('provider is required for ModashProfile'));
  }
  return next();
});

/* ------------------------------ Instance Methods ------------------------ */

modashSchema.methods.isLinkedToInfluencer = function () {
  return !!(this.influencer || this.influencerId);
};

modashSchema.methods.getDisplayName = function () {
  return this.fullname || this.username || this.handle || 'Unknown';
};

/* ------------------------------ Static Methods -------------------------- */

modashSchema.statics.findByUserIdAndProvider = function (userId, provider) {
  return this.findOne({ userId, provider });
};

modashSchema.statics.findByInfluencer = function (influencerId) {
  return this.find({
    $or: [{ influencer: influencerId }, { influencerId: String(influencerId) }],
  });
};

module.exports = mongoose.model('Modash', modashSchema);
