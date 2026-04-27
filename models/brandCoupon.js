const mongoose = require("mongoose");

const brandCouponSchema = new mongoose.Schema(
  {
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
    },

    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    mode:{
      type: String,
    },

    newPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    hasUsed: {
      type: Boolean,
      default: false,
    },

   promocode:{
        type: String,
        required: true,
        unique: true,
    },
   
    expiredAt: {
      type: Date,
      required: true,
    },

  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("BrandCoupon", brandCouponSchema);