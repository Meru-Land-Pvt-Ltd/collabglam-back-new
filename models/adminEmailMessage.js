// src/model/adminEmailMessage.js
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
    },

    to: {
      type: [String],
      default: [],
    },

    messageId: {
      type: String,
      default: null,
      index: true,
    },

    s3Bucket: {
      type: String,
      default: null,
    },

    s3Key: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

const AdminEmailMessageModel =
  mongoose.models.AdminEmailMessage ||
  mongoose.model("AdminEmailMessage", adminEmailMessageSchema);

module.exports = AdminEmailMessageModel;