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

    textPreview: {
      type: String,
      default: null,
    },

    htmlPreview: {
      type: String,
      default: null,
    },

    s3Bucket: {
      type: String,
      default: null,
    },

    s3Key: {
      type: String,
      default: null,
    },

    rawHeaders: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

const AdminEmailMessageModel =
  mongoose.models.AdminEmailMessage ||
  mongoose.model("AdminEmailMessage", adminEmailMessageSchema);

module.exports = AdminEmailMessageModel;