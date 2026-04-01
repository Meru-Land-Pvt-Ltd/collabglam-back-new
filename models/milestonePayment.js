const mongoose = require("mongoose");

const milestonePaymentSchema = new mongoose.Schema(
  {
    // link to milestone records
    milestoneId: { type: String, default: "" },
    milestoneHistoryId: { type: String, default: "" },

    brandId: { type: String, required: true, index: true },
    influencerId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },

    campaignName: { type: String, default: "" },
    milestoneTitle: { type: String, default: "" },

    // where this payment came from
    fundingSource: {
      type: String,
      enum: ["wallet", "stripe"],
      default: "wallet",
      index: true,
    },

    // if paid directly through stripe (optional)
    stripeSessionId: { type: String, default: null, index: true },
    stripePaymentIntentId: { type: String, default: null },
    stripeSignature: { type: String, default: null },

    // if funded from campaign wallet
    walletTransactionId: { type: String, default: null, index: true },
    walletTopupSessionId: { type: String, default: null },
    walletCampaignFrozenAmount: { type: Number, default: 0 }, // cents snapshot
    walletReleasedAmount: { type: Number, default: 0 }, // cents

    // payment amount
    amount: { type: Number, required: true }, // cents
    currency: { type: String, required: true, default: "USD" },

    receipt: { type: String, default: "" },

    status: {
      type: String,
      enum: ["created", "initiated", "paid", "failed"],
      default: "initiated",
      index: true,
    },

    createdAt: { type: Date, default: Date.now },
    paidAt: { type: Date, default: null },

    invoiceNumber: { type: String, default: "" },
    invoiceIssuedAt: { type: Date, default: null },

    customerLegalName: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    customerTaxId: { type: String, default: "" },

    billingAddress: {
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      postal_code: { type: String, default: "" },
      country: { type: String, default: "" },
    },

    subtotalCents: { type: Number, default: 0 },
    discountCents: { type: Number, default: 0 },
    taxCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },

    invoiceFilePath: { type: String, default: "" },
    invoiceEmailTo: { type: String, default: "" },
    invoiceEmailSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

milestonePaymentSchema.index({ brandId: 1, campaignId: 1, influencerId: 1 });
milestonePaymentSchema.index({ milestoneId: 1, milestoneHistoryId: 1 });
milestonePaymentSchema.index({ fundingSource: 1, status: 1 });

module.exports =
  mongoose.models.MilestonePayment ||
  mongoose.model("MilestonePayment", milestonePaymentSchema);