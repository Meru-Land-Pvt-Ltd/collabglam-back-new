// models/mediaKit.js — v3.1 (Influencer snapshot minus subscription, payments, and auth/status fields)
// -----------------------------------------------------------------------------

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/* --------------------------------- Utils --------------------------------- */
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
const phoneRegex = /^[0-9]{10}$/;
const UUIDv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------------------------- Shared sub-schemas --------------------------- */
const weightItemSchema = new mongoose.Schema(
  { code: String, name: String, weight: Number },
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
    engagements: Number
  },
  { _id: false }
);

const sponsorSchema = new mongoose.Schema(
  { domain: String, logo_url: String, name: String },
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
    sponsors: [sponsorSchema]
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
    ethnicities: [weightItemSchema]
  },
  { _id: false }
);

/* ----------------------- Category link sub-schema ------------------------ */
const categoryLinkSchema = new mongoose.Schema(
  {
    categoryId: { type: Number, required: true, index: true },
    categoryName: { type: String, required: true, trim: true },
    subcategoryId: {
      type: String,
      required: true,
      index: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
  { _id: false }
);

/* -------- Minimal sub-schema for onboarding.subcategories -------- */
const onboardingSubcategorySchema = new mongoose.Schema(
  {
    subcategoryId: {
      type: String,
      required: true,
      index: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
  { _id: false }
);

/* ----------------------- Social profile sub-schema ----------------------- */
const socialProfileSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['youtube', 'tiktok', 'instagram'], required: true, index: true },

    // Identity
    userId: String,
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
    language: { code: String, name: String },

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

    // Bio/tags/brand
    bio: String,

    // Full category link objects
    categories: { type: [categoryLinkSchema], default: [] },

    hashtags: [{ tag: String, weight: Number }],
    mentions: [{ tag: String, weight: Number }],
    brandAffinity: [{ id: Number, name: String }],

    // Audience
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

    // Keep untouched provider payload too
    providerRaw: mongoose.Schema.Types.Mixed
  },
  { _id: false, timestamps: true }
);

/* -------------------------- Language sub-schema -------------------------- */
const languageRefSchema = new mongoose.Schema(
  {
    languageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Language', required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true }
  },
  { _id: false }
);

/* -------------------------- Onboarding sub-schema ------------------------ */
const onboardingSchema = new mongoose.Schema(
  {
    // STEP 4.1
    formats: { type: [String], default: [] },
    budgets: { type: [{ format: String, range: String }], default: [] },
    projectLength: { type: String },
    capacity: { type: String },

    // STEP 4.2
    categoryId: { type: Number, index: true },
    categoryName: { type: String, trim: true },

    // Minimal subcategory objects
    subcategories: { type: [onboardingSubcategorySchema], default: [] },

    collabTypes: { type: [String], default: [] },
    allowlisting: { type: Boolean, default: false },
    cadences: { type: [String], default: [] },
  },
  { _id: false }
);

/* --------------------------- MediaKit (v3.1) --------------------------- */
const mediaKitSchema = new mongoose.Schema(
  {
    // Primary key tying to Influencer
    mediaKitId: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
      match: [UUIDv4Regex, 'Invalid mediaKitId (must be UUID v4)']
    },
    influencerId: { type: String, required: true, unique: true, index: true },

    // === Influencer snapshot (EXCEPT subscription, paymentMethods, and auth/status fields) ===
    name: { type: String },
    email: { type: String, match: [emailRegex, 'Invalid email'] },
    phone: { type: String, match: [phoneRegex, 'Invalid phone'] },

    primaryPlatform: { type: String, enum: ['youtube', 'tiktok', 'instagram', 'other', null], default: null },
    socialProfiles: { type: [socialProfileSchema], default: [] },

    countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country' },
    country: { type: String },
    callingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country' },
    callingcode: { type: String },

    city: { type: String, trim: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ['Female', 'Male', 'Non-binary', 'Prefer not to say', ''], default: '' },

    languages: { type: [languageRefSchema], default: [] },
    onboarding: { type: onboardingSchema, default: {} },

    createdAt: { type: Date },

    // === MediaKit-only extras ===
    rateCard: { type: String,default:null },        // requested field #1
    additionalNotes: { type: String, default:null }, // requested field #2

    // Optional collateral
    mediaKitPdf: String,
    website: String
  },
  { timestamps: true, minimize: true }
);

/* ---------------------- Helpful Indexes for Filters ---------------------- */
mediaKitSchema.index({ email: 1 });
mediaKitSchema.index({ 'socialProfiles.provider': 1 });
mediaKitSchema.index({ 'socialProfiles.categories.subcategoryId': 1 });
mediaKitSchema.index({ 'languages.languageId': 1 });
mediaKitSchema.index({ 'onboarding.categoryId': 1 });
mediaKitSchema.index({ city: 1 });
mediaKitSchema.index({ 'onboarding.subcategories.subcategoryId': 1 });

module.exports = mongoose.model('MediaKit', mediaKitSchema);
