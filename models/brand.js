const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FREE_PLAN_ID = "dcd11cf7-50ca-4891-ae15-5045080f72fe";

const subscriptionFeatureSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed, default: null },
    limit: { type: Number, required: true, default: 0 },
    used: { type: Number, default: 0 },
    note: { type: String, default: null, trim: true },
    resetsEvery: { type: String, default: null, trim: true },
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

    planRef: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },

    monthlyCost: { type: Number, default: 0 },
    annualCost: { type: Number, default: 0 },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },

    autoRenew: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "archived"], default: "active" },

    durationMins: { type: Number, default: 43200 },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    features: { type: [subscriptionFeatureSchema], default: [] },
    internalCredits: { type: internalCreditsSchema, default: () => ({}) },
  },
  { _id: false }
);

const brandSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    brandName: {
      type: String,
      required: [true, "Brand name is required"],
      trim: true,
    },

    name: {
      type: String,
      default: "",
      trim: true,
    },

    companySize: {
      type: String,
      default: "",
      trim: true,
    },

    industry: {
      type: String,
      required: [true, "Industry is required"],
      trim: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false,
    },

    proxyEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      validate: {
        validator(value) {
          return !value || emailRegex.test(value);
        },
        message: "Invalid proxy email",
      },
    },

    profilePic: { type: String, default: "", trim: true },

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
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        ret.brandId = String(ret._id);
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete ret.password;
        ret.brandId = String(ret._id);
        return ret;
      },
    },
  }
);

brandSchema.index({ email: 1 }, { unique: true });

brandSchema.pre("save", async function preSave(next) {
  try {
    if (!this.isModified("password")) return next();

    const pwd = String(this.password || "");
    const alreadyHashed = /^\$2[aby]\$\d{2}\$/.test(pwd) && pwd.length === 60;

    if (alreadyHashed) return next();

    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(pwd, salt);
    return next();
  } catch (error) {
    return next(error);
  }
});

brandSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(String(candidate || ""), String(this.password));
};

module.exports = mongoose.models.Brand || mongoose.model("Brand", brandSchema);