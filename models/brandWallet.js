const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const InfluencerAllocationSchema = new Schema(
  {
    influencerId: { type: String, required: true, index: true },
    amount: { type: Number, default: 0, min: 0 },

    releasedAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const CampaignFreezeSchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },

    totalFrozenAmount: { type: Number, default: 0, min: 0 },

    currentFrozenAmount: { type: Number, default: 0, min: 0 },

    totalAllocatedAmount: { type: Number, default: 0, min: 0 },

    totalReleasedAmount: { type: Number, default: 0, min: 0 },

    availableToAllocate: { type: Number, default: 0, min: 0 },

    influencerAllocations: {
      type: [InfluencerAllocationSchema],
      default: [],
    },
  },
  { _id: false }
);

const WalletTopupSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd" },
    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
    },
    createdAt: { type: Date, default: Date.now },

    paymentIntentId: { type: String, default: null },
    stripeSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },

    campaignId: { type: String, default: null },

    source: {
      type: String,
      enum: ["stripe", "admin_manual"],
      default: "stripe",
    },
    note: { type: String, default: "" },
    addedByAdminId: { type: String, default: null },
    addedByAdminEmail: { type: String, default: null },
  },
  { _id: false }
);

const BrandWalletSchema = new Schema(
  {
    brandId: { type: String, required: true, unique: true, index: true },

    // total money in wallet
    walletBalance: { type: Number, default: 0, min: 0 },

    // only free / non-frozen money
    usableBalance: { type: Number, default: 0, min: 0 },

    // campaign-based frozen buckets
    freezes: { type: [CampaignFreezeSchema], default: [] },

    topups: { type: [WalletTopupSchema], default: [] },
  },
  { timestamps: true }
);

BrandWalletSchema.index({ brandId: 1 });
BrandWalletSchema.index({ brandId: 1, "freezes.campaignId": 1 });
BrandWalletSchema.index({
  brandId: 1,
  "freezes.campaignId": 1,
  "freezes.influencerAllocations.influencerId": 1,
});

const BrandWalletModel = model("BrandWallet", BrandWalletSchema);

module.exports = { BrandWalletModel };