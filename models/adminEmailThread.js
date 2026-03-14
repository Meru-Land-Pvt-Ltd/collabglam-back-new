// src/model/adminEmailThread.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const adminEmailThreadSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

    executiveId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },

    modashId: {
      type: Schema.Types.ObjectId,
      ref: "Modash",
      required: true,
      index: true,
    },

    executiveEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },

    subject: {
      type: String,
      required: true,
      trim: true,
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// prevent duplicate threads
adminEmailThreadSchema.index(
  { campaignId: 1, executiveId: 1, modashId: 1 },
  { unique: true }
);

const AdminEmailThreadModel =
  mongoose.models.AdminEmailThread ||
  mongoose.model("AdminEmailThread", adminEmailThreadSchema);

module.exports = AdminEmailThreadModel;