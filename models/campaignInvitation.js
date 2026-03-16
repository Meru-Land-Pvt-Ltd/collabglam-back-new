const mongoose = require("mongoose");
const { Schema } = mongoose;

const CampaignInvitationSchema = new Schema(
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
    platform: {
      type: String,
      trim: true,
      default: "",
    },
    handle: {
      type: String,
      trim: true,
      default: "",
    },
    modashUserId: {
      type: String,
      default: null,
      trim: true,
    },
    influencerId: {
      type: Schema.Types.ObjectId,
      ref: "Influencer",
      default: null,
      index: true,
    },
    missingEmailId: {
      type: String,
      default: null,
    },
    emailTo: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ["sent", "accepted", "failed", "reject"],
      default: "sent",
      index: true,
    },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failReason: { type: String, default: null },
    createdByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

CampaignInvitationSchema.index(
  { brandId: 1, campaignId: 1, influencerId: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.CampaignInvitation ||
  mongoose.model("CampaignInvitation", CampaignInvitationSchema);