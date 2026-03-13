const mongoose = require("mongoose");

const milestoneHistorySchema = new mongoose.Schema(
  {
    influencerId: {
      type: String,
      required: true,
    },
    campaignId: {
      type: String,
      required: true,
    },
    milestoneTitle: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    milestoneDescription: {
      type: String,
      default: "",
    },
    released: {
      type: Boolean,
      default: false,
    },
    releasedAt: {
      type: Date,
    },
    payoutStatus: {
      type: String,
      enum: ["pending", "initiated", "paid"],
      default: "pending",
    },
    paidAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

const milestoneSchema = new mongoose.Schema(
  {
    brandId: {
      type: String,
      required: true,
      index: true,
    },

    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },

    milestoneHistory: {
      type: [milestoneHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Milestone", milestoneSchema);