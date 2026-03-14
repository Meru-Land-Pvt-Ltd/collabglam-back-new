// models/delieverable.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const deliverableUrlSchema = new Schema(
  {
    label: { type: String, default: "", trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const delieverableSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

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

    // Root milestone document _id
    milestoneId: {
      type: Schema.Types.ObjectId,
      ref: "Milestone",
      required: true,
      index: true,
    },

    // milestoneHistory subdocument _id
    milestoneHistoryId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["pending", "revision", "approved"],
      default: "pending",
      index: true,
    },

    approvedRole: {
      type: String,
      enum: ["", "Brand", "Admin"],
      default: "",
    },

    // Optional external/manual approval reference
    approvalId: {
      type: String,
      default: "",
      trim: true,
    },

    comments: {
      type: String,
      default: "",
      trim: true,
    },

    url: {
      type: [deliverableUrlSchema],
      default: [],
    },
  },
  {
    timestamps: true, // createdAt + updatedAt
    versionKey: false,
    collection: "delieverables",
  }
);

delieverableSchema.index({ campaignId: 1, createdAt: -1 });
delieverableSchema.index({ campaignId: 1, status: 1, createdAt: -1 });
delieverableSchema.index({ influencerId: 1, campaignId: 1 });
delieverableSchema.index({ brandId: 1, createdAt: -1 });
delieverableSchema.index({ milestoneHistoryId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Delieverable ||
  mongoose.model("Delieverable", delieverableSchema);