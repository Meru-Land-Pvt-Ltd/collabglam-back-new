// models/milestone.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const milestoneHistorySchema = new Schema(
  {
    influencerId: {
      type: Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    milestoneTitle: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    milestoneDescription: {
      type: String,
      default: "",
      trim: true,
    },
    released: {
      type: Boolean,
      default: false,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
    payoutStatus: {
      type: String,
      enum: ["pending", "initiated", "paid"],
      default: "pending",
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);   

const milestoneSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
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
  {
    timestamps: true,
    versionKey: false,
  }
);

milestoneSchema.index({ brandId: 1, createdAt: -1 });
milestoneSchema.index({ "milestoneHistory.influencerId": 1, "milestoneHistory.campaignId": 1 });

module.exports =
  mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema);