// models/subscription.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const featureSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    note: { type: String }, // optional human-readable hint
  },
  { _id: false }
);

const addOnSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["one_time", "recurring"], default: "one_time" },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USD" },
    payload: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const ctaSchema = new mongoose.Schema(
  {
    text: { type: String }, // e.g. "Start Pro", "Book a Call"
    action: {
      type: String,
      enum: ["start", "upgrade", "book_call", "contact_sales"],
      default: "start",
    },
    url: { type: String }, // optional deep link
  },
  { _id: false }
);

const subscriptionPlanSchema = new mongoose.Schema({
  planId: { type: String, required: true, unique: true, default: uuidv4 },

  role: {
    type: String,
    enum: ["Brand", "Influencer", "Creator", "Agency"],
    required: true,
  },

  name: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String },
  label: { type: String },

  monthlyCost: { type: Number, required: true, min: 0 },
  annualCost: { type: Number, min: 0 },
  currency: { type: String, default: "USD" },

  isCustomPricing: { type: Boolean, default: false },
  isStartingAt: { type: Boolean, default: false },
  annualBillingNote: {
    type: String,
    default: "discounted annual total (12 months)",
  },

  bestFor: { type: String },
  mainOutcome: { type: String },
  overview: { type: String },

  cta: { type: ctaSchema, default: {} },

  features: { type: [featureSchema], default: [] },

  addons: { type: [addOnSchema], default: [] },

  autoRenew: { type: Boolean, default: false },
  status: { type: String, enum: ["active", "archived"], default: "active" },

  durationMins: { type: Number, default: 43200 },
  durationMinutes: { type: Number },
  durationDays: { type: Number },

  sortOrder: { type: Number, default: 100 },

  createdAt: { type: Date, default: Date.now },
});

subscriptionPlanSchema.index({ role: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
