const { Schema, model } = require("mongoose");

const ROLES = {
  SUPER_ADMIN: "super_admin",
  REVENUE_HEAD: "revenue_head",
  IME: "ime",
  BME: "bme",
};

const AdminAccessSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    isDelete: { type: Boolean, default: true },
    isEdit: { type: Boolean, default: true },
    isManager: { type: Boolean, default: false },
  },
  { _id: false }
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

    role: {
      type: String,
      required: true,
      enum: Object.values(ROLES),
    },

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
    },

    invitedAt: { type: Date },
    inviteTokenHash: { type: String, select: false },
    inviteExpiresAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },

    // direct reporting manager
    parentAdmin: { type: Schema.Types.ObjectId, ref: "Admin", default: null },

    // top-most super admin under which tree belongs
    rootAdmin: { type: Schema.Types.ObjectId, ref: "Admin", default: null },

    // only useful for faster querying / UI
    teamType: {
      type: String,
      enum: ["leadership", "sales", "execution", null],
      default: null,
    },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// Helpful indexes
AdminSchema.index({ role: 1 });
AdminSchema.index({ parentAdmin: 1 });
AdminSchema.index({ rootAdmin: 1 });
AdminSchema.index({ createdBy: 1 });

const AdminModel = model("Master", AdminSchema);

module.exports = {
  AdminModel,
  ROLES,
};