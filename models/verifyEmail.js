// models/verifyEmail.js
const mongoose = require('mongoose');

const emailRegex =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/; // relaxed + valid TLD length

const verifyEmailSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      match: [emailRegex, 'Invalid email'],
      trim: true,
      lowercase: true, // normalize for unique index + equality matches
    },
    role: {
      type: String,
      enum: ['Brand', 'Influencer'],
      required: true,
    },

    otpCode: { type: String },
    otpExpiresAt: { type: Date },

    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },

    // number of OTP sends / attempts
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Ensure one verification record per (email, role)
verifyEmailSchema.index({ email: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('VerifyEmail', verifyEmailSchema);
