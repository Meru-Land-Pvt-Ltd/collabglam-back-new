// models/campaignInvitation.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const CampaignInvitationSchema = new mongoose.Schema(
  {
    invitationId: { type: String, default: uuidv4, index: true, unique: true },

    // campaign + brand
    brandId: { type: String, required: true, },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true},
    campaignsId: { type: String, default: null }, // optional (if you also store string id)

    // influencer identity
    platform: { type: String, default: "youtube", },
    handle: { type: String, required: true, }, 
    modashUserId: { type: String, required: true, }, 
    influencerId: { type: String, default: null }, 

    // email resolution
    missingEmailId: { type: String, default: null },
    emailTo: { type: String, default: null },

    // status
    status: {
      type: String,
      enum: ["created", "queued", "sent", "failed"],
      default: "created",
      index: true,
    },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failReason: { type: String, default: null },

    // audit
    createdByAdminId: { type: String, default: null },
  },
  { timestamps: true }
);

// prevent duplicates (same brand + campaign + handle + platform)


module.exports = mongoose.model("CampaignInvitation", CampaignInvitationSchema);