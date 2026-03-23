const mongoose = require("mongoose");

const adminEmailThreadSchema = new mongoose.Schema(
  {
    pipelineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InfluencerPipeline",
      default: null,
      index: true,
    },

    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
      index: true,
    },

    executiveId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["super_admin", "revenue_head", "ime", "bme"],
      required: true,
      index: true,
    },

    senderEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      index: true,
    },

    recipientEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      index: true,
    },

    replyToEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      unique: true,
      index: true,
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

    lastMessageDirection: {
      type: String,
      enum: ["INBOUND", "OUTBOUND"],
      default: "OUTBOUND",
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "ARCHIVED", "CLOSED"],
      default: "ACTIVE",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// one pipeline row = one thread
adminEmailThreadSchema.index(
  { pipelineId: 1 },
  { unique: true, partialFilterExpression: { pipelineId: { $type: "objectId" } } }
);

// fallback uniqueness if pipelineId is not used yet
adminEmailThreadSchema.index({ executiveId: 1, recipientEmail: 1 });

// better query support
adminEmailThreadSchema.index({ campaignId: 1, executiveId: 1, lastMessageAt: -1 });

module.exports =
  mongoose.models.AdminEmailThread ||
  mongoose.model("AdminEmailThread", adminEmailThreadSchema);