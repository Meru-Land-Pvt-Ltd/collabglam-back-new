const mongoose = require("mongoose");
const { Schema } = mongoose;

const adminEmailMessageSchema = new Schema(
  {
    threadId: {
      type: Schema.Types.ObjectId,
      ref: "AdminEmailThread",
      required: true,
      index: true,
    },
    pipelineId: {
      type: Schema.Types.ObjectId,
      ref: "InfluencerPipeline",
      default: null,
      index: true,
    },
    brandOutreachId: {
      type: Schema.Types.ObjectId,
      ref: "BrandOutreach",
      default: null,
      index: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
      index: true,
    },
    actorAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },
    ownerAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },
    direction: {
      type: String,
      enum: ["INBOUND", "OUTBOUND"],
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    from: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      index: true,
    },
    to: {
      type: [String],
      default: [],
    },
    cc: {
      type: [String],
      default: [],
    },
    bcc: {
      type: [String],
      default: [],
    },
    replyTo: {
      type: [String],
      default: [],
    },
    messageId: {
      type: String,
      default: null,
      index: true,
    },
    inReplyTo: {
      type: String,
      default: null,
      index: true,
    },
    references: {
      type: [String],
      default: [],
    },
    provider: {
      type: String,
      enum: ["SES"],
      default: "SES",
      index: true,
    },
    providerStatus: {
      type: String,
      enum: [
        "QUEUED",
        "SENT",
        "DELIVERED",
        "BOUNCED",
        "COMPLAINED",
        "FAILED",
        "RECEIVED",
      ],
      default: "QUEUED",
      index: true,
    },
    textPreview: String,
    htmlPreview: String,
    s3Bucket: String,
    s3Key: String,
    attachments: [
      {
        filename: { type: String, default: null },
        contentType: { type: String, default: null },
        contentDisposition: { type: String, default: null },
        contentId: { type: String, default: null },
        transferEncoding: { type: String, default: null },
        size: { type: Number, default: 0 },
        checksum: { type: String, default: null },
        related: { type: Boolean, default: false },
        s3Bucket: { type: String, default: null },
        s3Key: { type: String, default: null },
      },
    ],

    rawHeaders: {
      type: Schema.Types.Mixed,
      default: null,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

adminEmailMessageSchema.index({ threadId: 1, createdAt: 1 });
adminEmailMessageSchema.index({ pipelineId: 1, createdAt: 1 });
adminEmailMessageSchema.index({ brandOutreachId: 1, createdAt: 1 });
adminEmailMessageSchema.index({ campaignId: 1, createdAt: 1 });

module.exports =
  mongoose.models.AdminEmailMessage ||
  mongoose.model("AdminEmailMessage", adminEmailMessageSchema);