// models/influencer.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/* --------------------------------- Utils --------------------------------- */
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
const phoneRegex = /^[0-9]{10}$/;
const UUIDv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------- NEW: Minimal sub-schema for onboarding.subcategories ---------- */
const onboardingSubcategorySchema = new mongoose.Schema(
  {
    subcategoryId: {
      type: String,
      required: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
  { _id: false }
);

/* -------------------------- Language sub-schema -------------------------- */
const languageRefSchema = new mongoose.Schema(
  {
    languageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Language', required: true },
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

    // ✅ Minimal subcategory objects (no categoryId/categoryName)
    subcategories: { type: [onboardingSubcategorySchema], default: [] },

    collabTypes: { type: [String], default: [] },
    allowlisting: { type: Boolean, default: false },
    cadences: { type: [String], default: [] },

    // STEP 4.3
    selectedPrompts: { type: [{ group: String, prompt: String }], default: [] },
    promptAnswers: {
      type: [{ group: String, prompt: String, answer: String }],
      default: []
    },

    influencerTourSeen: { type: Boolean, default: false },
    influencerTourSeenAt: { type: Date, default: null },

  },
  { _id: false }
);

/* -------------------------- Payment sub-schema --------------------------- */
const paymentSchema = new mongoose.Schema(
  {
    paymentId: { type: String, default: () => uuidv4() },
    // 0: PayPal, 1: Bank
    type: { type: Number, enum: [0, 1], required: true },
    bank: {
      accountHolder: { type: String, required: function () { return this.type === 1; } },
      accountNumber: { type: String, required: function () { return this.type === 1; } },
      ifsc: { type: String },
      swift: { type: String },
      bankName: { type: String, required: function () { return this.type === 1; } },
      branch: { type: String },
      countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.type === 1; } },
      countryName: { type: String, required: function () { return this.type === 1; } }
    },
    paypal: {
      email: { type: String, match: [emailRegex, 'Invalid PayPal email'], required: function () { return this.type === 0; } },
      username: { type: String }
    },
    isDefault: { type: Boolean, default: false }
  },
  { _id: false, timestamps: true }
);

/* --------------------------- Influencer schema --------------------------- */
const influencerSchema = new mongoose.Schema(
  {
    influencerId: { type: String, required: true, unique: true, default: uuidv4 },

    name: { type: String, required: function () { return this.otpVerified; } },
    email: { type: String, required: true, match: [emailRegex, 'Invalid email'] },
    password: { type: String, minlength: 8, required: function () { return this.otpVerified; } },
    phone: { type: String, match: [phoneRegex, 'Invalid phone'], default: '' },

    // High-level info only – Modash profile data is in the Modash model now
    primaryPlatform: {
      type: String,
      enum: ['youtube', 'tiktok', 'instagram', 'other', null],
      default: null
    },

    countryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Country',
      required: function () { return this.otpVerified; }
    },
    country: { type: String, required: function () { return this.otpVerified; } },
    callingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', default: null },
    callingcode: { type: String, default: null },

    city: { type: String, trim: true },
    dateOfBirth: { type: Date },
    gender: {
      type: String,
      enum: ['Female', 'Male', 'Non-binary', 'Prefer not to say', ''],
      default: ''
    },

    languages: { type: [languageRefSchema], default: [] },

    onboarding: { type: onboardingSchema, default: {} },

    createdAt: { type: Date, default: Date.now },

    otpCode: { type: String },
    otpExpiresAt: { type: Date },
    otpVerified: { type: Boolean, default: false },

    passwordResetCode: { type: String },
    passwordResetExpiresAt: { type: Date },
    passwordResetVerified: { type: Boolean, default: false },

    paymentMethods: { type: [paymentSchema], default: [] },
    influencerAliasEmail: {
      type: String,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    subscription: {
      planName: { type: String },      // no required, no default
      planId: { type: String },      // no required, no default
      startedAt: { type: Date },
      expiresAt: { type: Date },
      features: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, required: true },
              limit: { type: Number, required: true },
              used: { type: Number, required: true }
            },
            { _id: false }
          )
        ],
        default: []
      }
    },

    subscriptionExpired: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    isUnsubscribed: { type: Boolean, default: false }
  },
  { timestamps: true, minimize: true }
);

/* ---------------------- Helpful Indexes for Filters ---------------------- */
influencerSchema.index({ email: 1 }, { unique: true });
// ⛔️ REMOVED: 'socialProfiles.provider' index
// ⛔️ REMOVED: 'socialProfiles.categories.subcategoryId' index
influencerSchema.index({ 'languages.languageId': 1 });
influencerSchema.index({ 'onboarding.categoryId': 1 });
influencerSchema.index({ city: 1 });

// Lookup by selected subcategories in onboarding
influencerSchema.index({ 'onboarding.subcategories.subcategoryId': 1 });

/* -------------------- Only one default payment method -------------------- */
influencerSchema.pre('validate', function (next) {
  if (Array.isArray(this.paymentMethods)) {
    this.paymentMethods.forEach((pm) => { if (!pm.paymentId) pm.paymentId = uuidv4(); });
    const defaults = this.paymentMethods.filter((pm) => pm.isDefault);
    if (defaults.length > 1) {
      return next(new Error('Only one payment method can be marked as default.'));
    }
  }
  next();
});

influencerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (e) {
    next(e);
  }
});

influencerSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

influencerSchema.index(
  { 'paymentMethods.paymentId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'paymentMethods.paymentId': { $exists: true, $ne: null }
    }
  }
);

module.exports = mongoose.model('Influencer', influencerSchema);
