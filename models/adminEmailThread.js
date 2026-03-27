const mongoose = require("mongoose");

const adminEmailThreadSchema = new mongoose.Schema(
  {
    pipelineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InfluencerPipeline",
      default: null,
      index: true,
    },
    brandOutreachId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BrandOutreach",
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
    lastActorAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },
    updatedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
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

adminEmailThreadSchema.index(
  { pipelineId: 1 },
  { unique: true, partialFilterExpression: { pipelineId: { $type: "objectId" } } }
);

adminEmailThreadSchema.index(
  { brandOutreachId: 1 },
  { unique: true, partialFilterExpression: { brandOutreachId: { $type: "objectId" } } }
);

adminEmailThreadSchema.index({ executiveId: 1, recipientEmail: 1 });
adminEmailThreadSchema.index({ campaignId: 1, executiveId: 1, lastMessageAt: -1 });

module.exports =
  mongoose.models.AdminEmailThread ||
  mongoose.model("AdminEmailThread", adminEmailThreadSchema);