const mongoose = require("mongoose");

const adminEmailThreadSchema = new mongoose.Schema(
  {
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      
    },
    executiveId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
     
    },
    executiveEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
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
  {
    timestamps: true,
    versionKey: false,
  }
);

// One thread per brand + campaign + executive



module.exports = mongoose.model("AdminEmailThread", adminEmailThreadSchema);