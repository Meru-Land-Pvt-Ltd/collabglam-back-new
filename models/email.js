const mongoose = require("mongoose");

const { Schema } = mongoose;

// ---------------- Helper: slugify name ----------------
function slugifyName(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .substring(0, 20) || "user"
  );
}

// ---------------- Email Thread Schema ----------------
const emailThreadSchema = new mongoose.Schema(
  {
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      index: true,
    },

    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Influencer",
      index: true,
    },

    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
      index: true,
    },

    campaignSnapshot: {
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
      title: { type: String, default: "" },
      campaignType: { type: String, default: "" },
    },

    subject: { type: String },

    lastMessageAt: { type: Date, index: true },

    lastMessageDirection: {
      type: String,
      enum: ["brand_to_influencer", "influencer_to_brand", null],
      default: null,
    },

    lastMessageSnippet: { type: String },

    hasInfluencerReplied: {
      type: Boolean,
      default: false,
      index: true,
    },

    brandAliasEmail: {
      type: String,
      lowercase: true,
      index: true,
    },

    influencerAliasEmail: {
      type: String,
      lowercase: true,
      index: true,
    },

    brandDisplayAlias: { type: String },
    influencerDisplayAlias: { type: String },

    brandSnapshot: {
      name: String,
      email: String,
    },

    influencerSnapshot: {
      name: String,
      email: String,
    },

    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
    },

    createdBy: { type: String },
  },
  { timestamps: true }
);

// one thread per brand + influencer + campaign
emailThreadSchema.index(
  { brand: 1, influencer: 1, campaign: 1 },
  { unique: true }
);

emailThreadSchema.statics.generateAliasEmail = function (displayName) {
  const slug = slugifyName(displayName);
  const domain = process.env.EMAIL_RELAY_DOMAIN || "mail.collabglam.cloud";
  return `${slug}@${domain}`;
};

emailThreadSchema.statics.generatePrettyAlias =
  emailThreadSchema.statics.generateAliasEmail;

// ---------------- Email Message Schema ----------------
const emailMessageSchema = new mongoose.Schema(
  {
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailThread",
      required: true,
      index: true,
    },

    direction: {
      type: String,
      enum: ["brand_to_influencer", "influencer_to_brand", "system"],
      required: true,
    },

    fromUser: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "fromUserModel",
    },

    fromUserModel: {
      type: String,
      enum: ["Brand", "Influencer", "System"],
    },

    fromAliasEmail: { type: String },
    toRealEmail: { type: String },

    fromProxyEmail: {
      type: String,
      lowercase: true,
      index: true,
    },

    toProxyEmail: {
      type: String,
      lowercase: true,
      index: true,
    },

    fromRealEmail: {
      type: String,
      lowercase: true,
      index: true,
    },

    subject: String,
    htmlBody: String,
    textBody: String,

    messageId: { type: String, index: true },
    inReplyTo: { type: String, index: true },
    references: [String],

    forwardedSesMessageId: { type: String, index: true },

    sentAt: { type: Date },
    receivedAt: { type: Date },

    attachments: [
      {
        filename: String,
        contentType: String,
        size: Number,
        storageKey: String,
        url: String,
      },
    ],
  },
  { timestamps: true }
);

emailMessageSchema.index({ thread: 1, direction: 1, createdAt: -1 });

emailMessageSchema.index(
  { thread: 1, messageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      messageId: { $exists: true, $ne: null },
    },
  }
);

emailMessageSchema.index({ forwardedSesMessageId: 1 }, { sparse: true });

// ---------------- Email Template Schema ----------------
const emailTemplateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    role: {
      type: String,
      enum: ["Brand", "Influencer", "Both"],
      default: "Both",
    },
    type: { type: String, default: "generic" },

    subject: { type: String, required: true },
    htmlBody: { type: String, required: true },
    textBody: { type: String },

    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const EmailThread =
  mongoose.models.EmailThread ||
  mongoose.model("EmailThread", emailThreadSchema);

const EmailMessage =
  mongoose.models.EmailMessage ||
  mongoose.model("EmailMessage", emailMessageSchema);

const EmailTemplate =
  mongoose.models.EmailTemplate ||
  mongoose.model("EmailTemplate", emailTemplateSchema);

module.exports = {
  EmailThread,
  EmailMessage,
  EmailTemplate,
};