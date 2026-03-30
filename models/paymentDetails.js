const mongoose = require("mongoose");

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const paymentSchema = new mongoose.Schema(
  {
    influencerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true, // removed unique: true
    },

    // optional label for UI
    label: {
      type: String,
      trim: true,
      default: "",
    },

    // 0 = PayPal, 1 = Bank
    type: {
      type: Number,
      enum: [0, 1],
      required: true,
    },

    bank: {
      accountHolder: {
        type: String,
        required: function () {
          return this.type === 1;
        },
      },
      accountNumber: {
        type: String,
        required: function () {
          return this.type === 1;
        },
      },
      ifsc: { type: String },
      swift: { type: String },
      bankName: {
        type: String,
        required: function () {
          return this.type === 1;
        },
      },
      branch: { type: String },
      countryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Country",
        required: function () {
          return this.type === 1;
        },
      },
      countryName: {
        type: String,
        required: function () {
          return this.type === 1;
        },
      },
    },

    paypal: {
      email: {
        type: String,
        match: [emailRegex, "Invalid PayPal email"],
        required: function () {
          return this.type === 0;
        },
      },
      username: { type: String },
    },

    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentDetails", paymentSchema);