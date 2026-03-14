const { Schema, model } = require("mongoose");

const AdminAccessSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    isDelete: { type: Boolean, default: true },
    isEdit: { type: Boolean, default: true },
    isManager: { type: Boolean, default: false },
  },
  { _id: false } // keeps access items clean (no extra _id per item)
);

const AdminSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, trim: true },
    role: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "active", "suspended", "inactive"],
      default: "pending",
    },
    access: { type: [AdminAccessSchema], default: [] },
    passwordHash: { type: String, select: false },
    proxyEmail: {
        type: String,
        unique: true,
        sparse: true,
        lowercase: true,
        trim: true,
      },    invitedAt: { type: Date },
    inviteTokenHash: { type: String, select: false },
    inviteExpiresAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

const AdminModel = model("Master", AdminSchema);

module.exports = { AdminModel };