// models/payment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String },
  signature: { type: String },

  // Stripe amounts in cents
  amount: { type: Number, required: true },

  // ✅ USD only
  currency: { type: String, required: true, default: "USD" },

  receipt: { type: String },

  userId: { type: String, required: true },
  role: { type: String, required: true, enum: ["Brand", "Influencer"] },

  planId: { type: String, required: true },
  planName: { type: String, default: "" },

  status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date },

  // ✅ invoice identifiers
  invoiceNumber: { type: String },
  invoiceIssuedAt: { type: Date },

  // ✅ enterprise customer details
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

  // ✅ totals (tax line always)
  subtotalCents: { type: Number, default: 0 },
  discountCents: { type: Number, default: 0 },
  taxCents: { type: Number, default: 0 },
  totalCents: { type: Number, default: 0 },

  // ✅ subscription service period
  servicePeriodStart: { type: Date },
  servicePeriodEnd: { type: Date },

  // file/email tracking
  invoiceFilePath: { type: String },
  invoiceEmailTo: { type: String },
  invoiceEmailSentAt: { type: Date },
});

module.exports = mongoose.model("Payment", paymentSchema);