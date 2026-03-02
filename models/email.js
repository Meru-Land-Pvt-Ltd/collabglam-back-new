// models/email.js
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
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", index: true },
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Influencer",
      index: true,
    },

    // conversation-level info
    subject: { type: String },

    lastMessageAt: { type: Date, index: true },
    lastMessageDirection: {
      type: String,
      enum: ["brand_to_influencer", "influencer_to_brand", null],
      default: null,
    },
    lastMessageSnippet: { type: String },

    // ✅ NEW: once influencer replies at least once, conversation becomes free forever
    hasInfluencerReplied: { type: Boolean, default: false, index: true },

    // Proxy emails in use for this pair
    brandAliasEmail: { type: String, lowercase: true, index: true },
    influencerAliasEmail: { type: String, lowercase: true, index: true },

    // What we display as "From" in UI
    brandDisplayAlias: { type: String },
    influencerDisplayAlias: { type: String },

    // Snapshots for UI
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

    createdBy: { type: String }, // 'brand' | 'influencer' | 'system'
  },
  { timestamps: true }
);

// Only one thread per brand + influencer pair
emailThreadSchema.index({ brand: 1, influencer: 1 }, { unique: true });

emailThreadSchema.statics.generateAliasEmail = function (displayName) {
  const slug = slugifyName(displayName);
  const domain = process.env.EMAIL_RELAY_DOMAIN || "mail.collabglam.com";
  return `${slug}@${domain}`;
};

// alias & display are identical
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
    fromUserModel: { type: String, enum: ["Brand", "Influencer", "System"] },

    // Existing field (keep)
    fromAliasEmail: { type: String },
    toRealEmail: { type: String },

    // explicit proxy/real addressing
    fromProxyEmail: { type: String, lowercase: true, index: true },
    toProxyEmail: { type: String, lowercase: true, index: true },
    fromRealEmail: { type: String, lowercase: true, index: true },

    subject: String,
    htmlBody: String,
    textBody: String,

    // Email threading fields
    messageId: { type: String, index: true }, // Message-ID header
    inReplyTo: { type: String, index: true }, // In-Reply-To header
    references: [String],

    // ✅ SES MessageId of the FORWARDED email (useful for routing replies & debugging)
    forwardedSesMessageId: { type: String, index: true },

    // Timestamps from the email’s perspective
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

// ✅ Recommended for fast policy checks
emailMessageSchema.index({ thread: 1, direction: 1, createdAt: -1 });

// ✅ Optional but recommended: prevent duplicate Message-ID per thread (safe with sparse)
emailMessageSchema.index({ thread: 1, messageId: 1 }, { unique: true, sparse: true });

// ✅ Optional: faster lookups when searching a forwarded SES messageId
emailMessageSchema.index({ forwardedSesMessageId: 1 }, { sparse: true });

// ---------------- Email Template Schema ----------------
const emailTemplateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    role: { type: String, enum: ["Brand", "Influencer", "Both"], default: "Both" },
    type: { type: String, default: "generic" },

    subject: { type: String, required: true },
    htmlBody: { type: String, required: true },
    textBody: { type: String },

    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const EmailThread = mongoose.model("EmailThread", emailThreadSchema);
const EmailMessage = mongoose.model("EmailMessage", emailMessageSchema);
const EmailTemplate = mongoose.model("EmailTemplate", emailTemplateSchema);

module.exports = {
  EmailThread,
  EmailMessage,
  EmailTemplate,
};
