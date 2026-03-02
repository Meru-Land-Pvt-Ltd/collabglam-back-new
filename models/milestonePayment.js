// models/milestonePayment.js
const mongoose = require("mongoose");

const milestonePaymentSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String },
  signature: { type: String },

  amount: { type: Number, required: true }, // cents
  currency: { type: String, required: true, default: "USD" },
  receipt: { type: String },

  brandId: { type: String, required: true },
  influencerId: { type: String, required: true },
  campaignId: { type: String, required: true },
  campaignName: { type: String, default: "" },
  milestoneTitle: { type: String, default: "" },

  status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date },

  invoiceNumber: { type: String },
  invoiceIssuedAt: { type: Date },

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

  invoiceFilePath: { type: String },
  invoiceEmailTo: { type: String },
  invoiceEmailSentAt: { type: Date },
});

module.exports = mongoose.model("MilestonePayment", milestonePaymentSchema);