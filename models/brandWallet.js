const mongoose = require("mongoose");
const { Schema, model, Types } = mongoose;

const FrozenCampaignSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    freezeAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const BrandWalletSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, unique: true, index: true },

    // TOTAL wallet balance = usable + frozen
    walletBalance: { type: Number, default: 0, min: 0 },

    // stored usable balance
    usableBalance: { type: Number, default: 0, min: 0 },

    freezes: { type: [FrozenCampaignSchema], default: [] },
  },
  { timestamps: true }
);

BrandWalletSchema.index({ brandId: 1 });
BrandWalletSchema.index({ brandId: 1, "freezes.campaignId": 1 });
BrandWalletSchema.index({ "freezes.brandId": 1, "freezes.campaignId": 1 });

const BrandWalletModel = model("BrandWallet", BrandWalletSchema);

module.exports = { BrandWalletModel };