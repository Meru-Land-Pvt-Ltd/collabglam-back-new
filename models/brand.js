// models/brand.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

// ---- helpers / enums (optional) ----
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const DEFAULT_FREE_PLAN_ID = "dcd11cf7-50ca-4891-ae15-5045080f72fe";

// ---------------- Subscription sub-schemas ----------------
const subscriptionFeatureSchema = new Schema(
  {
    key: { type: String, required: true },

    value: { type: Schema.Types.Mixed, default: null },

    limit: { type: Number, required: true },

    used: { type: Number, default: 0 },

    note: { type: String, default: null },
    resetsEvery: { type: String, default: null },
    resetsAt: { type: Date, default: null },
  },
  { _id: false }
);

const internalCreditsSchema = new Schema(
  {
    used: { type: Number, default: 0 },
    resetsAt: { type: Date, default: null },
  },
  { _id: false }
);

const subscriptionSchema = new Schema(
  {
    planId: { type: String, required: true, default: DEFAULT_FREE_PLAN_ID },
    planName: { type: String, required: true, default: "free" },
    role: { type: String, enum: ["Brand", "Influencer"], default: "Brand" },

    planRef: { type: Schema.Types.ObjectId, ref: "SubscriptionPlan", default: null },

    monthlyCost: { type: Number, default: 0 },
    annualCost: { type: Number, default: 0 },
    billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },

    autoRenew: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "archived"], default: "active" },

    durationMins: { type: Number, default: 43200 }, // 30 days
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    features: { type: [subscriptionFeatureSchema], default: [] },

    internalCredits: { type: internalCreditsSchema, default: () => ({}) },
  },
  { _id: false }
);

// ---------------- Brand Schema (NEW FIELDS + subscription) ----------------
const brandSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    brandName: { type: String, required: true, trim: true },
    name: { type: String, trim: true },

    // optional (choose enum or plain string)
    companySize: { type: String, required: false, trim: true },

    industry: { type: String, required: true, trim: true },

    password: { type: String, required: true, minlength: 8 },

    proxyEmail: { type: String, trim: true },
    profilePic: { type: String, trim: true },

    page1: { type: [Schema.Types.Mixed], default: [] },
    page2: { type: [Schema.Types.Mixed], default: [] },
    page3: { type: [Schema.Types.Mixed], default: [] },

    ispage1Skip: { type: Boolean, default: false },
    ispage2Skip: { type: Boolean, default: false },
    ispage3Skip: { type: Boolean, default: false },
    isProfilePicSkip: { type: Boolean, default: false },

    subscription: { type: subscriptionSchema, default: () => ({}) },
    subscriptionExpired: { type: Boolean, default: false },

    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

brandSchema.pre("save", async function (next) {
  try {
    if (!this.isModified("password")) return next();

    // ✅ if already bcrypt hashed, don't hash again
    const pwd = String(this.password || "");
    const looksHashed = /^\$2[aby]\$\d{2}\$/.test(pwd) && pwd.length === 60;
    if (looksHashed) return next();

    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(pwd, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare password helper
brandSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.models.Brand || mongoose.model("Brand", brandSchema);