// src/model/verifyOtp.js
const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const VerifyOtpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    otp: { type: String, required: true, trim: true },

    status: { type: Number, enum: [0, 1], default: 0, required: true },
    role: { type: String, enum: ["brand", "influencer"], required: true },
    userId: { type: Schema.Types.ObjectId, default: null, required: false },

    docType: { type: String, enum: ["otp", "limit"], default: "otp" },
    purpose: { type: String, enum: ["signup", "reset_password"], required: false },

    // ✅ UPDATED enum
    key: {
      type: String,
      enum: ["signup_limit", "forgot_limit", "signin_limit"],
      required: false,
    },

    // ✅ OTP limiter (existing)
    signupOtpSend: { type: Number, default: 6 },
    signupOtpBatchCount: { type: Number, default: 0 },
    signupOtpCooldownUntil: { type: Date, default: null },
    signupOtpResetAt: { type: Date, default: null },

    // ✅ NEW signin limiter
    signinFailedCount: { type: Number, default: 0 },
    signinCooldownUntil: { type: Date, default: null },
    signinResetAt: { type: Date, default: null },

    signupPayload: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// ✅ only ONE limiter doc per email+role+key
VerifyOtpSchema.index(
  { email: 1, role: 1, key: 1 },
  { unique: true, partialFilterExpression: { key: { $exists: true } } }
);

const VerifyOtpModel = model("VerifyOtp", VerifyOtpSchema);

// ✅ export model directly
module.exports = VerifyOtpModel;