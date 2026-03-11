const mongoose = require("mongoose");

const { Schema } = mongoose;

const VerifyOtpSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    otp: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: Number,
      enum: [0, 1], // 0 = pending, 1 = used
      default: 0,
      required: true,
    },

    role: {
      type: String,
      enum: ["brand", "influencer"],
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    docType: {
      type: String,
      enum: ["otp", "limit"],
      default: "otp",
      required: true,
      index: true,
    },

    purpose: {
      type: String,
      enum: ["signup", "reset_password"],
      default: undefined,
      index: true,
    },

    key: {
      type: String,
      enum: ["signup_limit", "forgot_limit", "signin_limit"],
      default: undefined,
    },

    expiresAt: {
      type: Date,
      default: undefined,
    },

    signupOtpSend: { type: Number, default: 6 },
    signupOtpBatchCount: { type: Number, default: 0 },
    signupOtpCooldownUntil: { type: Date, default: null },
    signupOtpResetAt: { type: Date, default: null },

    signinFailedCount: { type: Number, default: 0 },
    signinCooldownUntil: { type: Date, default: null },
    signinResetAt: { type: Date, default: null },

    signupPayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

// one limiter doc per email + role + key
VerifyOtpSchema.index(
  { email: 1, role: 1, docType: 1, key: 1 },
  {
    unique: true,
    partialFilterExpression: {
      docType: "limit",
      key: { $exists: true },
    },
  }
);

// latest pending OTP lookup
VerifyOtpSchema.index({
  email: 1,
  role: 1,
  docType: 1,
  purpose: 1,
  status: 1,
  createdAt: -1,
});

// delete expired OTP docs automatically
VerifyOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.VerifyOtp || mongoose.model("VerifyOtp", VerifyOtpSchema);