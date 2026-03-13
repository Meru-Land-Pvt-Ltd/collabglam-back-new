const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const FrozenAllocationSchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },
    influencerId: { type: String, required: true, index: true },
    freezeAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const WalletTopupSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "inr" },
    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
    },
    createdAt: { type: Date, default: Date.now },

    // optional only, not required
    paymentIntentId: { type: String, default: null },
  },
  { _id: false }
);

const BrandWalletSchema = new Schema(
  {
    brandId: { type: String, required: true, unique: true, index: true },

    walletBalance: { type: Number, default: 0, min: 0 },
    usableBalance: { type: Number, default: 0, min: 0 },

    freezes: { type: [FrozenAllocationSchema], default: [] },
    topups: { type: [WalletTopupSchema], default: [] },
  },
  { timestamps: true }
);

BrandWalletSchema.index({ brandId: 1 });
BrandWalletSchema.index({ brandId: 1, "freezes.campaignId": 1 });
BrandWalletSchema.index({ brandId: 1, "freezes.campaignId": 1, "freezes.influencerId": 1 });

const BrandWalletModel = model("BrandWallet", BrandWalletSchema);

module.exports = { BrandWalletModel };