const mongoose = require("mongoose");

const portalSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // "charges"
    charges: {
      // defaults (used when plan does not override)
      brand_marketplace_fee_percent_default: { type: Number, default: 10 },
      influencer_platform_fee_percent_default: { type: Number, default: 10 },

      payment_gateway_percent: { type: Number, default: 0 },
      gst_percent: { type: Number, default: 0 },
      tds_percent: { type: Number, default: 0 },
      withdrawal_fee_percent: { type: Number, default: 0 }
    },
    updatedByAdminId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("PortalSettings", portalSettingsSchema);