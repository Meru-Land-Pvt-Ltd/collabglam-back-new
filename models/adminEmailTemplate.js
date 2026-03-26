const mongoose = require("mongoose");
const { Schema } = mongoose;

const adminEmailTemplateSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    subject: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },

    body: {
      type: String,
      default: "",
    },

    visibility: {
      type: String,
      enum: ["GLOBAL", "TREE", "PERSONAL"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "ARCHIVED"],
      default: "ACTIVE",
      index: true,
    },

    createdByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      required: true,
      index: true,
    },

    updatedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    ownerAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    treeAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    createdByRole: {
      type: String,
      enum: ["super_admin", "revenue_head", "ime", "bme"],
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

adminEmailTemplateSchema.index({ visibility: 1, treeAdminId: 1, status: 1 });
adminEmailTemplateSchema.index({ visibility: 1, ownerAdminId: 1, status: 1 });
adminEmailTemplateSchema.index({ createdByAdminId: 1, createdAt: -1 });

module.exports =
  mongoose.models.AdminEmailTemplate ||
  mongoose.model("AdminEmailTemplate", adminEmailTemplateSchema);