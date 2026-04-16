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

const genderPerAgeSchema = new mongoose.Schema(
  {
    code: String,
    male: Number,
    female: Number,
  },
  { _id: false }
);

const geoNameWeightSchema = new mongoose.Schema(
  {
    name: String,
    weight: Number,
  },
  { _id: false }
);

const geoSubdivisionItemSchema = new mongoose.Schema(
  {
    name: String,
    weight: Number,
  },
  { _id: false }
);

const geoSubdivisionSchema = new mongoose.Schema(
  {
    name: String,
    code: String,
    items: [geoSubdivisionItemSchema],
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    type: String,
    value: String,
  },
  { _id: false }
);

const interestSchema = new mongoose.Schema(
  {
    id: Number,
    name: String,
  },
  { _id: false }
);

const statHistorySchema = new mongoose.Schema(
  {
    month: String,
    followers: Number,
    following: Number,
    avgLikes: Number,
    avgViews: Number,
    avgComments: Number,
    avgShares: Number,
  },
  { _id: false }
);

const audienceDistributionSchema = new mongoose.Schema(
  {
    min: Number,
    max: Number,
    total: Number,
    median: Boolean,
  },
  { _id: false }
);

const audienceExtraSchema = new mongoose.Schema(
  {
    followersRange: {
      leftNumber: Number,
      rightNumber: Number,
    },
    engagementRateDistribution: [audienceDistributionSchema],
    credibilityDistribution: [audienceDistributionSchema],
  },
  { _id: false }
);

const audienceSchema = new mongoose.Schema(
  {
    notable: Number,
    genders: [weightItemSchema],
    geoCountries: [weightItemSchema],
    ages: [weightItemSchema],
    gendersPerAge: [genderPerAgeSchema],
    languages: [weightItemSchema],
    notableUsers: [userLiteSchema],
    audienceLookalikes: [userLiteSchema],
    geoCities: [geoNameWeightSchema],
    geoStates: [geoNameWeightSchema],
    geoSubdivisions: [geoSubdivisionSchema],
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
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      required: false,
      index: true,
    },

    influencerId: {
      type: String,
      required: false,
      index: true,
    },

    provider: {
      type: String,
      enum: ['youtube', 'tiktok', 'instagram'],
      required: true,
      index: true,
    },

    userId: {
      type: String,
      required: true,
      index: true,
    },

    username: String,
    fullname: String,
    handle: String,
    url: String,
    picture: String,

    followers: Number,
    engagements: Number,
    engagementRate: Number,
    averageViews: Number,

    isPrivate: Boolean,
    isVerified: Boolean,
    accountType: String,
    secUid: String,

    city: String,
    state: String,
    subdivision: String,
    country: String,
    ageGroup: String,
    gender: String,

    language: mongoose.Schema.Types.Mixed,
    contacts: [contactSchema],

    statsByContentType: mongoose.Schema.Types.Mixed,
    stats: mongoose.Schema.Types.Mixed,

    recentPosts: [postSchema],
    popularPosts: [postSchema],

    postsCount: Number,
    postsCounts: Number,
    avgLikes: Number,
    avgComments: Number,
    avgViews: Number,
    avgReelsPlays: Number,
    totalLikes: Number,
    totalViews: Number,

    bio: String,

    categories: { type: [categoryLinkSchema], default: [] },

    hashtags: [mongoose.Schema.Types.Mixed],
    mentions: [mongoose.Schema.Types.Mixed],
    brandAffinity: [mongoose.Schema.Types.Mixed],
    interests: [interestSchema],

    audience: audienceSchema,
    audienceCommenters: audienceSchema,
    lookalikes: [userLiteSchema],

    sponsoredPosts: [postSchema],
    paidPostPerformance: Number,
    paidPostPerformanceViews: Number,
    sponsoredPostsMedianViews: Number,
    sponsoredPostsMedianLikes: Number,
    nonSponsoredPostsMedianViews: Number,
    nonSponsoredPostsMedianLikes: Number,

    statHistory: [statHistorySchema],
    audienceExtra: audienceExtraSchema,

    providerRaw: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
  }
);

/* ------------------------------ Indexes ---------------------------------- */

modashSchema.index(
  { userId: 1, provider: 1 },
  {
    unique: true,
    name: 'userId_provider_unique',
  }
);

modashSchema.index(
  { influencerId: 1 },
  {
    sparse: true,
    name: 'influencerId_lookup',
  }
);

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

  if (
    (this.postsCount === undefined || this.postsCount === null) &&
    this.postsCounts !== undefined &&
    this.postsCounts !== null
  ) {
    this.postsCount = this.postsCounts;
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